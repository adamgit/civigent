/**
 * C3 — YJS_UPDATE propagation must be a SINGLE server-applied-delta broadcast.
 *
 * Before C3 the `MSG_YJS_UPDATE` handler ran TWO propagation paths: (1) inside
 * `processArbitratedClientUpdate`, a conditional full-state broadcast on revert;
 * and (2) an unconditional raw-bytes relay of the client payload to the other
 * sockets. The spec mandates ONE mechanism: the server applies the change and the
 * resulting update IS the broadcast (spec 05 §Fragment Injection / §Structural
 * Normalization). The raw relay is the dumb y-websocket relay, valid only when the
 * server never rejects an edit — but arbitration DOES reject (revert) edits.
 *
 * These tests drive the REAL binary-frame handler with two connected sockets
 * (sender + peer; the peer's outbound frames are applied to a replica Y.Doc) and
 * assert that the peer:
 *  (1) converges to server truth when an edit is blocked (the blocked edit is
 *      absent from the peer), receiving EXACTLY ONE server-applied YJS_UPDATE
 *      frame (no second raw relay); and
 *  (2) in a mixed update (one frame touching a WON fragment X and a BLOCKED
 *      fragment Y) receives X but NOT Y.
 *
 * The single-frame assertion is the load-bearing C3 property: under the old
 * dual-broadcast code the peer received TWO frames (correction + raw relay).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  handleMessageForTest,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { FragmentContent, SectionBody } from "../../storage/section-formatting.js";
import { encodeUpdate, decodeMessage, MSG_YJS_UPDATE } from "../../ws/crdt-ws-frames.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { createProposal, transitionToInProgress } from "../../storage/proposal-repository.js";
import type { WsServerEvent } from "../../types/shared.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

/** Build a client update rewriting one or more fragments relative to server state. */
function buildClientUpdate(session: DocSession, writes: Array<[string, FragmentContent]>): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  for (const [key, content] of writes) tempStore.replaceFragmentString(key, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

async function lockSectionWithCompetingProposal(headingPath: string[]): Promise<void> {
  const { id } = await createProposal(
    { id: "user-bob", type: "human", displayName: "Bob" },
    "Competing lock",
    [{ doc_path: SAMPLE_DOC_PATH, heading_path: headingPath }],
  );
  expect((await transitionToInProgress(id)).acquired).toBe(true);
}

describe("C3: YJS_UPDATE propagation is a single server-applied-delta broadcast", () => {
  let ctx: TempDataRootContext;
  let events: WsServerEvent[];
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    events = [];
    setCrdtEventHandler((e) => events.push(e));
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  /** Register sender + peer sockets; the peer applies received YJS_UPDATE frames to a replica. */
  function setupSenderAndPeer(session: DocSession): {
    senderSocket: import("ws").WebSocket;
    senderState: import("../../ws/crdt-transport.js").CrdtSocketState;
    peer: Y.Doc;
    peerStore: LiveFragmentStringsStore;
    peerFrameCount: () => number;
  } {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(session.ydoc));
    const peerStore = new LiveFragmentStringsStore(peer, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);

    let frames = 0;
    const applyToPeer = (data: Uint8Array) => {
      const decoded = decodeMessage(data);
      if (decoded?.type === MSG_YJS_UPDATE) {
        frames++;
        Y.applyUpdate(peer, decoded.payload);
      }
    };

    const sender = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-A");
    const peerReg = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-B", applyToPeer);
    disposers.push(sender.dispose, peerReg.dispose);

    return {
      senderSocket: sender.socket,
      senderState: sender.state,
      peer,
      peerStore,
      peerFrameCount: () => frames,
    };
  }

  it("(1) a blocked edit: peer converges to server truth via a single delta (no raw relay)", async () => {
    const session = await openSession();
    await lockSectionWithCompetingProposal(["Overview"]); // Overview is competing-locked

    const { senderSocket, senderState, peerStore, peerFrameCount } = setupSenderAndPeer(session);

    const blocked = buildFragmentContent("BLOCKED EDIT BY ALICE" as SectionBody, 2, "Overview");
    const frame = Buffer.from(encodeUpdate(buildClientUpdate(session, [[OVERVIEW_KEY, blocked]])));
    await handleMessageForTest(senderSocket, senderState, frame);

    // The peer received EXACTLY ONE server-applied delta (the old dual-broadcast
    // code sent two: a correction AND the raw client relay).
    expect(peerFrameCount()).toBe(1);

    // The peer converged to server truth: the blocked edit is absent.
    const peerOverview = peerStore.readFragmentString(OVERVIEW_KEY) as string;
    expect(peerOverview).not.toContain("BLOCKED EDIT BY ALICE");
    expect(peerOverview).toContain("The overview covers our strategic goals.");

    // section:blocked was emitted for the competing-locked fragment.
    expect(events.some((e) => e.type === "section:blocked"
      && (e as { fragment_key?: string }).fragment_key === OVERVIEW_KEY)).toBe(true);
  });

  it("(2) a mixed update: peer receives the WON fragment but NOT the blocked one", async () => {
    const session = await openSession();
    await lockSectionWithCompetingProposal(["Overview"]); // Overview blocked; Timeline free

    const { senderSocket, senderState, peerStore, peerFrameCount } = setupSenderAndPeer(session);

    // One update touches BOTH a blocked fragment (Overview) and a won one (Timeline).
    const frame = Buffer.from(encodeUpdate(buildClientUpdate(session, [
      [OVERVIEW_KEY, buildFragmentContent("BLOCKED OVERVIEW" as SectionBody, 2, "Overview")],
      [TIMELINE_KEY, buildFragmentContent("WON TIMELINE EDIT" as SectionBody, 2, "Timeline")],
    ])));
    await handleMessageForTest(senderSocket, senderState, frame);

    expect(peerFrameCount()).toBe(1);

    // The peer received the won Timeline edit but NOT the blocked Overview edit.
    const peerTimeline = peerStore.readFragmentString(TIMELINE_KEY) as string;
    const peerOverview = peerStore.readFragmentString(OVERVIEW_KEY) as string;
    expect(peerTimeline).toContain("WON TIMELINE EDIT");
    expect(peerOverview).not.toContain("BLOCKED OVERVIEW");
    expect(peerOverview).toContain("The overview covers our strategic goals.");
  });
});
