import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createApp } from "../../app.js";
import { setSystemReady } from "../../startup-state.js";
import { createCrdtWsServer } from "../../ws/crdt-sync.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { issueTokenPair } from "../../auth/tokens.js";
import {
  MSG_MODE_TRANSITION_REQUEST,
  MSG_MODE_TRANSITION_RESULT,
  MSG_SYNC_STEP_2,
} from "../../ws/crdt-protocol.js";
import type { WriterIdentity, ModeTransitionRequest, ModeTransitionResult } from "../../types/shared.js";
import { destroyAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { getSessionSectionsContentRoot } from "../../storage/data-root.js";
import { RawFragmentRecoveryBuffer } from "../../storage/raw-fragment-recovery-buffer.js";
import { access } from "node:fs/promises";
import path from "node:path";

function rawToUint8Array(raw: WebSocket.RawData): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === "string") return new TextEncoder().encode(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  return new Uint8Array(raw as Buffer);
}

async function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Uint8Array) => boolean,
  timeoutMs = 4000,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = rawToUint8Array(raw);
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onClose = () => { cleanup(); reject(new Error("WebSocket closed before expected message")); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

async function waitForOpen(ws: WebSocket, timeoutMs = 4000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for ws open")); }, timeoutMs);
    const onOpen = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("WebSocket closed before opening")); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("open", onOpen);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    ws.on("open", onOpen);
    ws.on("close", onClose);
    ws.on("error", onError);
  });
}

function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  const msg = new Uint8Array(1 + payload.length);
  msg[0] = type;
  msg.set(payload, 1);
  return msg;
}

async function requestModeTransition(
  ws: WebSocket,
  request: ModeTransitionRequest,
): Promise<ModeTransitionResult> {
  ws.send(encodeMessage(MSG_MODE_TRANSITION_REQUEST, new TextEncoder().encode(JSON.stringify(request))));
  const resultMsg = await waitForMessage(ws, (msg) => msg[0] === MSG_MODE_TRANSITION_RESULT);
  return JSON.parse(new TextDecoder().decode(resultMsg.subarray(1))) as ModeTransitionResult;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe("session-end cleanup is independent of changedSections count", () => {
  let ctx: TempDataRootContext;
  let app: ReturnType<typeof createApp>;
  let server: Server;
  let port: number;
  let writer: WriterIdentity;
  let writerToken: string;
  let openSockets: WebSocket[] = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setSystemReady();
    app = createApp();

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

    writer = {
      id: "cleanup-writer",
      type: "human",
      displayName: "Cleanup Writer",
      email: "cleanup-writer@test.local",
    };
    writerToken = issueTokenPair({
      id: writer.id,
      type: writer.type,
      displayName: writer.displayName,
    }).access_token;
  });

  afterEach(async () => {
    destroyAllSessions();
    for (const s of openSockets) { if (s.readyState === WebSocket.OPEN) s.close(); }
    openSockets = [];
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.cleanup();
  });

  it("removes overlay + fragments after a no-edit editor session", async () => {
    const overlayRoot = getSessionSectionsContentRoot();
    const normalized = SAMPLE_DOC_PATH.replace(/\\/g, "/").replace(/^\/+/, "");
    const skeletonPath = path.resolve(overlayRoot, ...normalized.split("/"));
    const sectionsDir = `${skeletonPath}.sections`;

    const clientInstanceId = "client-cleanup-noop";
    const ws = new WebSocket(
      `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=${clientInstanceId}`,
      { headers: { Authorization: `Bearer ${writerToken}` } },
    );
    openSockets.push(ws);
    await waitForOpen(ws);

    const syncPromise = waitForMessage(ws, (msg) => msg[0] === MSG_SYNC_STEP_2);
    const editorResult = await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "editor",
      editorFocusTarget: null,
    });
    expect(editorResult.kind).toBe("success");
    await syncPromise;

    // NO edits — transition straight back to none, triggering finalizeSessionEnd.
    const noneResult = await requestModeTransition(ws, {
      requestId: crypto.randomUUID(),
      clientInstanceId,
      docPath: SAMPLE_DOC_PATH,
      requestedMode: "none",
      editorFocusTarget: null,
    });
    expect(noneResult.kind).toBe("success");

    // Cleanup must have run despite changedSections.length === 0.
    expect(await exists(skeletonPath)).toBe(false);
    expect(await exists(sectionsDir)).toBe(false);

    const recoveryBuffer = new RawFragmentRecoveryBuffer(SAMPLE_DOC_PATH);
    const fragments = await recoveryBuffer.listPersistedFragments();
    expect(fragments).toEqual([]);
  });

  it("does not run cleanup when absorb throws (crash-recovery safety)", async () => {
    // Spy on RawFragmentRecoveryBuffer.deleteAllFragments — it's called in the
    // cleanup block of finalizeSessionEnd and should NOT run when absorb throws.
    const deleteAllCalls: string[] = [];
    const originalDeleteAll = RawFragmentRecoveryBuffer.prototype.deleteAllFragments;
    RawFragmentRecoveryBuffer.prototype.deleteAllFragments = async function (this: { docPath: string }) {
      deleteAllCalls.push(this.docPath);
      return originalDeleteAll.call(this);
    };

    // Force absorb to throw for this test's session.
    const originalAbsorb = CanonicalStore.prototype.absorbChangedSections;
    CanonicalStore.prototype.absorbChangedSections = async function () {
      throw new Error("test-forced absorb failure");
    };

    try {
      const clientInstanceId = "client-cleanup-absorb-fail";
      const ws = new WebSocket(
        `ws://localhost:${port}/ws/crdt${SAMPLE_DOC_PATH}?clientInstanceId=${clientInstanceId}`,
        { headers: { Authorization: `Bearer ${writerToken}` } },
      );
      openSockets.push(ws);
      await waitForOpen(ws);

      const syncPromise = waitForMessage(ws, (msg) => msg[0] === MSG_SYNC_STEP_2);
      const editorResult = await requestModeTransition(ws, {
        requestId: crypto.randomUUID(),
        clientInstanceId,
        docPath: SAMPLE_DOC_PATH,
        requestedMode: "editor",
        editorFocusTarget: null,
      });
      expect(editorResult.kind).toBe("success");
      await syncPromise;

      // The close handler's absorb-throw surfaces as an unhandled rejection —
      // that is the production behavior (cleanup-on-error is a node-level
      // concern, not something finalizeSessionEnd catches). Consume it here so
      // it doesn't trip vitest's unhandled-error reporter.
      const onUnhandled = (reason: unknown) => {
        if (reason instanceof Error && reason.message.includes("test-forced absorb failure")) return;
        throw reason;
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        // Close the socket; close handler runs finalizeSessionEnd; absorb throws.
        const closedPromise = new Promise<void>((resolve) => ws.on("close", () => resolve()));
        ws.close();
        await closedPromise;
        // Give the async close handler time to attempt finalize + throw.
        await new Promise((r) => setTimeout(r, 100));

        // Cleanup MUST NOT have run: deleteAllFragments should never have been called.
        expect(deleteAllCalls).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    } finally {
      CanonicalStore.prototype.absorbChangedSections = originalAbsorb;
      RawFragmentRecoveryBuffer.prototype.deleteAllFragments = originalDeleteAll;
    }
  });
});
