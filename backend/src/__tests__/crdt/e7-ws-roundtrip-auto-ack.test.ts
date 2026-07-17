/**
 * E7 (integration, REAL transport): true WS round-trip with a client that
 * AUTO-acks the publish pause from its OWN barrier.
 *
 *   split → publish pause → client AUTO-acks (its own publish-pause barrier, NO
 *   hand-rolled `session.publishPause.markReady`) → commit → `content:committed`
 *
 * Every OTHER publish test in this suite drives the readiness ack by calling
 * `session.publishPause.markReady(socketId)` directly on the FSM, and fans frames
 * out through `registerFakeEditorSocketForTest`. E7 is the one test that stands up
 * a REAL `node:http` server + the production `createCrdtWsServer().handleUpgrade`
 * upgrade path + a REAL `ws` client socket, and lets the client produce the
 * `doc_publish_ready` ack itself in response to the `doc_publish_pause_start`
 * frame. So it is the end-to-end transport proof the live-split class needed: the
 * ack travels the wire from the client's own publish-pause barrier.
 *
 * It additionally asserts the client surfaces the new split section LIVE
 * (pre-commit): because the binary channel is FIFO per socket, the split Y.Doc
 * broadcast AND the ordered `LiveSectionsUpdateFrame` (0x15) carrying the fresh
 * topology both reach the client BEFORE the `doc_publish_pause_start` frame, so at
 * the instant the client runs its barrier and acks, its real Y.Doc already carries
 * the promoted "Second Section" fragment and its adopted live topology already
 * lists it — strictly before `content:committed`. (The old `doc:structure-changed`
 * app-event is gone; live topology authority is the CRDT frame now.)
 *
 * Harness note (assumptions.md 2026-06-24): the literal frontend `CrdtProvider`
 * class is browser-coupled (`window.location` at construction, the `apiClient` /
 * Vite `import.meta.env` module graph) and cannot be evaluated in the backend
 * node test env, so this uses a faithful transport client that mirrors
 * `CrdtProvider.handlePublishPauseStart` byte-for-byte on the wire: it freezes
 * (its own barrier), then sends `MSG_DOC_PUBLISH_READY` exactly once. The ack is
 * the client's decision, never `markReady`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { createApp } from "../../app.js";
import { createCrdtWsServer } from "../../ws/crdt-sync.js";
import {
  setCrdtEventHandler,
  resetCoordinatorPublishStateForTest,
} from "../../ws/crdt-ws-coordinator.js";
import {
  destroyAllSessions,
  lookupDocSession,
} from "../../crdt/ydoc-lifecycle.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { issueTokenPair } from "../../auth/tokens.js";
import { readSection } from "../../storage/section-reader.js";
import { SectionRef } from "../../domain/section-ref.js";
import { randomUUID } from "node:crypto";
import {
  MSG_SYNC_STEP_1,
  MSG_SYNC_STEP_2,
  MSG_YJS_UPDATE,
  MSG_AWARENESS,
  MSG_MODE_TRANSITION_REQUEST,
  MSG_MODE_TRANSITION_RESULT,
  MSG_DOC_PUBLISH_PAUSE_START,
  MSG_DOC_PUBLISH_READY,
  MSG_DOC_PUBLISH_PAUSE_END,
  MSG_LIVE_SECTIONS_BOOTSTRAP,
  MSG_LIVE_SECTIONS_UPDATE,
  decodeLiveSectionsBootstrap,
  decodeLiveSectionsUpdate,
} from "../../ws/crdt-ws-frames.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import type { WsServerEvent, WireLiveSectionsState, ModeTransitionResult } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

/** Captured app-events (the JSON channel the frontend adopts), in arrival order. */
interface CapturedEvent {
  order: number;
  event: WsServerEvent;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(stepMs);
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
}

/**
 * A faithful, REAL-socket transport client mirroring the production
 * `CrdtProvider` wire behaviour (handshake, sync, local-edit emit, and — the
 * point of E7 — the publish-pause auto-ack barrier). It owns a real `ws` socket
 * to the real server; nothing here reaches into the server's DocSession state.
 */
class TestCrdtClient {
  readonly doc = new Y.Doc();
  private readonly ws: WebSocket;
  readonly clientInstanceId = randomUUID();

  synced = false;
  modeResult: ModeTransitionResult | null = null;

  publishPaused = false;
  private publishReadySent = false;
  pauseStartCount = 0;
  pauseEndCount = 0;
  /** Snapshot at the instant the client ran its barrier on pause-start: did its
   *  real Y.Doc already carry the live split section (pre-commit)? */
  sawSplitSectionAtPauseStart: boolean | null = null;
  /** The most recent live-section topology (heading paths) delivered on the
   *  ordered CRDT channel via a bootstrap/update frame carrying `state`. */
  liveTopology: string[][] = [];
  /** Snapshot: at pause-start, had the ordered CRDT structural frame already
   *  delivered the promoted "Second Section" into the live topology? */
  sawSplitInLiveTopologyAtPauseStart: boolean | null = null;

  constructor(port: number, token: string) {
    const encoded = SAMPLE_DOC_PATH.replace(/^\//, "");
    const url =
      `ws://localhost:${port}/ws/crdt/${encoded}?clientInstanceId=${encodeURIComponent(this.clientInstanceId)}`;
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    this.ws.binaryType = "arraybuffer";

    this.ws.on("open", () => {
      // Mirror CrdtProvider.onopen: request editor mode, then sync step 1.
      this.sendRaw(MSG_MODE_TRANSITION_REQUEST, new TextEncoder().encode(JSON.stringify({
        requestId: randomUUID(),
        clientInstanceId: this.clientInstanceId,
        docPath: SAMPLE_DOC_PATH,
        requestedMode: "editor",
        editorFocusTarget: null,
      })));
      this.sendSyncStep1();
    });

    this.ws.on("message", (raw: ArrayBuffer | Buffer | Buffer[]) => {
      const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      this.handleMessage(new Uint8Array(buf));
    });
  }

  whenOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));
    });
  }

  close(): void {
    this.ws.removeAllListeners();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
    this.doc.destroy();
  }

  private handleMessage(data: Uint8Array): void {
    if (data.length === 0) return;
    const type = data[0];
    const payload = data.subarray(1);
    switch (type) {
      case MSG_SYNC_STEP_1: {
        const diff = Y.encodeStateAsUpdate(this.doc, payload);
        this.sendRaw(MSG_SYNC_STEP_2, diff);
        break;
      }
      case MSG_SYNC_STEP_2: {
        Y.applyUpdate(this.doc, payload, this);
        this.synced = true;
        break;
      }
      case MSG_YJS_UPDATE: {
        Y.applyUpdate(this.doc, payload, this);
        break;
      }
      case MSG_MODE_TRANSITION_RESULT: {
        this.modeResult = JSON.parse(new TextDecoder().decode(payload)) as ModeTransitionResult;
        break;
      }
      case MSG_DOC_PUBLISH_PAUSE_START: {
        this.handlePublishPauseStart();
        break;
      }
      case MSG_DOC_PUBLISH_PAUSE_END: {
        if (!this.publishPaused) break;
        this.publishPaused = false;
        this.publishReadySent = false;
        this.pauseEndCount += 1;
        break;
      }
      case MSG_LIVE_SECTIONS_BOOTSTRAP: {
        this.adoptLiveState(decodeLiveSectionsBootstrap(payload).state);
        break;
      }
      case MSG_LIVE_SECTIONS_UPDATE: {
        const frame = decodeLiveSectionsUpdate(payload);
        if (frame.state) this.adoptLiveState(frame.state);
        break;
      }
      case MSG_AWARENESS:
      default:
        break;
    }
  }

  /** Adopt the body-free live topology from an ordered CRDT frame (the redesign's
   *  replacement for the removed `doc:structure-changed` app-event). */
  private adoptLiveState(state: WireLiveSectionsState): void {
    this.liveTopology = state.topology.map((t) => [...t.heading_path]);
  }

  private liveTopologyHasHeading(text: string): boolean {
    return this.liveTopology.some((path) => path.at(-1) === text);
  }

  /** The publish-pause auto-ack barrier — a faithful copy of
   *  CrdtProvider.handlePublishPauseStart. The ack is produced HERE (client side)
   *  in response to the wire frame, never by the test calling markReady. */
  private handlePublishPauseStart(): void {
    if (this.publishPaused) return;
    this.publishPaused = true;
    this.publishReadySent = false;
    this.pauseStartCount += 1;
    // Pre-commit liveness: by FIFO ordering the split Y.Doc broadcast already
    // arrived, so the client's real Y.Doc should already carry "Second Section".
    this.sawSplitSectionAtPauseStart = this.hasSectionHeading("Second Section");
    // Same FIFO guarantee for the ordered CRDT structural frame: the 0x15 update
    // frame carrying the fresh topology is sent immediately after the Y.Doc
    // broadcast (one structural fact), both strictly before the pause-start frame.
    this.sawSplitInLiveTopologyAtPauseStart = this.liveTopologyHasHeading("Second Section");

    const send = (): void => {
      if (!this.publishPaused || this.publishReadySent) return;
      this.publishReadySent = true;
      this.sendRaw(MSG_DOC_PUBLISH_READY, new Uint8Array(0));
    };
    // No mounted editor produces further transactions → the barrier is trivially
    // quiescent, but route through a microtask to mirror `freeze().then(send)`.
    Promise.resolve().then(send);
  }

  /** True if any live fragment's content carries the given heading text. */
  hasSectionHeading(text: string): boolean {
    for (const name of this.doc.share.keys()) {
      const frag = this.doc.getXmlFragment(name);
      if (frag.toString().includes(text)) return true;
    }
    return false;
  }

  /** Type a sibling-heading split into the Overview fragment and send the diff
   *  over the real socket, exactly as the editor would on a keystroke burst. */
  sendSplitEdit(content: FragmentContent): void {
    const beforeSV = Y.encodeStateVector(this.doc);
    const keys = [...this.doc.share.keys()];
    const store = new LiveFragmentStringsStore(this.doc, keys, SAMPLE_DOC_PATH);
    store.replaceFragmentString(OVERVIEW_KEY, content);
    const update = Y.encodeStateAsUpdate(this.doc, beforeSV);
    this.sendRaw(MSG_YJS_UPDATE, update);
  }

  private sendSyncStep1(): void {
    this.sendRaw(MSG_SYNC_STEP_1, Y.encodeStateVector(this.doc));
  }

  private sendRaw(type: number, payload: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const msg = new Uint8Array(1 + payload.length);
    msg[0] = type;
    msg.set(payload, 1);
    this.ws.send(msg);
  }
}

describe("E7: true WS round-trip with client auto-ack (integration)", () => {
  let server: Server;
  let port: number;
  let dataCtx: TempDataRootContext;
  let captured: CapturedEvent[];
  let order = 0;

  beforeAll(async () => {
    dataCtx = await createTempDataRoot();
    await createSampleDocument(dataCtx.rootDir);

    const app = createApp();
    const crdtWs = createCrdtWsServer();
    server = createServer(app);
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;
      if (pathname.startsWith("/ws/crdt/")) {
        crdtWs.handleUpgrade(request, socket, head);
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    server?.close();
    destroyAllSessions();
    resetCoordinatorPublishStateForTest();
    setCrdtEventHandler(() => {});
    await dataCtx?.cleanup();
  });

  it("split → pause → auto-ack → commit → content:committed → client surfaces the section live", async () => {
    captured = [];
    order = 0;
    setCrdtEventHandler((event: WsServerEvent) => {
      captured.push({ order: order++, event });
    });

    const token = issueTokenPair(WRITER).access_token;
    const client = new TestCrdtClient(port, token);
    try {
      await client.whenOpen();

      // Editor mode acquired + initial sync completed (real handshake over the wire).
      await waitFor(() => client.modeResult?.kind === "success" && client.synced);
      expect(client.modeResult?.clientRole).toBe("editor");

      // Speed the autonomous quiescence trigger for the integration test (real
      // timers): lower the threshold BEFORE the edit arms the timer. This only
      // shortens the wait — it does not change any code path under test.
      const session = lookupDocSession(SAMPLE_DOC_PATH);
      expect(session).not.toBeNull();
      (session!.generator.publishTriggerPolicy as unknown as { quiescenceThresholdMs: number })
        .quiescenceThresholdMs = 120;

      // The author types a same-level (`##`) sibling heading into Overview.
      client.sendSplitEdit(
        "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent,
      );

      // The full round-trip is now autonomous: quiescence → split normalization
      // (Y.Doc broadcast + doc:structure-changed) → publish pause → the CLIENT
      // auto-acks over the wire → commit → content:committed.
      await waitFor(() => captured.some((c) => c.event.type === "content:committed"));
      // The pause ended on both sides (the binary pause-end frame reached the client).
      await waitFor(() => client.pauseEndCount === 1);

      // ── The client produced the ack from its OWN barrier (no markReady) ──
      expect(client.pauseStartCount).toBe(1);
      expect(client.pauseEndCount).toBe(1);

      // ── Pre-commit liveness: at the moment the client ran its barrier and acked,
      //    its real Y.Doc already carried the promoted split section. ──
      expect(client.sawSplitSectionAtPauseStart).toBe(true);
      expect(client.hasSectionHeading("Second Section")).toBe(true);

      // ── The ordered CRDT structural frame (what the LiveSectionReplica adopts,
      //    the redesign's replacement for the removed `doc:structure-changed`
      //    app-event) had already delivered the promoted sibling into the live
      //    topology at pause-start — i.e. strictly before commit. ──
      expect(client.sawSplitInLiveTopologyAtPauseStart).toBe(true);
      // The final live topology carries "Second Section" with its own fragment key.
      const second = client.liveTopology.find((path) => path.at(-1) === "Second Section");
      expect(second).toBeDefined();
      expect(SectionRef.headingKey(second!)).toBe(SectionRef.headingKey(["Second Section"]));

      // ── The auto-ack actually drove the commit to canonical. ──
      expect(session!.generator.hasCurrentProposal()).toBe(false);
      const canonicalSecond = await readSection(SAMPLE_DOC_PATH, ["Second Section"]);
      expect(canonicalSecond).toContain("brand new sibling body");
      const canonicalOverview = await readSection(SAMPLE_DOC_PATH, ["Overview"]);
      expect(canonicalOverview).toContain("base overview body");
      expect(canonicalOverview).not.toContain("## Second Section");
    } finally {
      client.close();
    }
  }, 20000);
});
