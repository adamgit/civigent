/**
 * E4: cross-client LIVE split (backend portion).
 *
 * Client A has the document mounted; client B types a same-level (`##`) sibling
 * heading into a section. At quiescence the server splits the section
 * structurally and fans the result out as ONE ordered `LiveSectionsUpdateFrame`
 * carrying BOTH the structural Yjs update and the fresh body-free topology
 * state — there is no raw `MSG_YJS_UPDATE` precursor for structural changes.
 * Body-only accepted edits likewise travel only as live-section `yjs_update`
 * frames (not raw `MSG_YJS_UPDATE`).
 *
 * Asserts the cross-client adoption that the live-split fix must guarantee: A's
 * Y.Doc receives the NEW sibling fragment AND the survivor shrinks (the moved-out
 * body is gone from A's copy of the survivor) — purely from the live-section
 * structural frame, with NO commit / `content:committed` required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  handleMessageForTest,
  joinAndNotify,
  registerFakeEditorSocketForTest,
  setCrdtEventHandler,
} from "../../ws/crdt-ws-coordinator.js";
import { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import {
  encodeUpdate,
  decodeMessage,
  decodeLiveSectionsUpdate,
  MSG_YJS_UPDATE,
  MSG_LIVE_SECTIONS_UPDATE,
} from "../../ws/crdt-ws-frames.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

function buildClientUpdate(session: DocSession, key: string, content: FragmentContent): Uint8Array {
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(session.ydoc));
  const tempStore = new LiveFragmentStringsStore(temp, session.liveFragments.getFragmentKeys(), SAMPLE_DOC_PATH);
  tempStore.replaceFragmentString(key, content);
  const update = Y.encodeStateAsUpdate(temp, Y.encodeStateVector(session.ydoc));
  temp.destroy();
  return update;
}

describe("E4: cross-client live split adoption (backend portion)", () => {
  let ctx: TempDataRootContext;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    setCrdtEventHandler(() => undefined);
  });

  afterEach(async () => {
    while (disposers.length) disposers.pop()!();
    setCrdtEventHandler(() => undefined);
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("client A's Y.Doc adopts the new sibling fragment and the shrunk survivor from B's split", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Client A: mounted. Replica applies `yjs_update` from ordered live-section
    // frames only (body-only and structural alike).
    const peerA = new Y.Doc();
    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(session.ydoc));
    let structuralFramesToA = 0;
    const quiescenceFrameTypes: number[] = [];
    const a = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-A", (data) => {
      const decoded = decodeMessage(data);
      if (decoded) quiescenceFrameTypes.push(decoded.type);
      if (decoded?.type === MSG_LIVE_SECTIONS_UPDATE) {
        const frame = decodeLiveSectionsUpdate(decoded.payload);
        if (frame.yjs_update) Y.applyUpdate(peerA, frame.yjs_update);
        if (frame.state !== undefined) structuralFramesToA += 1;
      }
    });
    // Bootstrap A onto the live-section channel so it receives ordered frames
    // (real joined sockets are always bootstrapped before structural updates).
    a.state.joined = false;
    joinAndNotify(session, a.socket, a.state);
    await session.enqueue(() => undefined);
    // Client B: the editor whose keystrokes split the section.
    const b = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-B");
    disposers.push(a.dispose, b.dispose);

    // B types a SAME-LEVEL (`##`) sibling heading into Overview and sends the frame.
    const dirty =
      "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent;
    await handleMessageForTest(
      b.socket,
      b.state,
      Buffer.from(encodeUpdate(buildClientUpdate(session, OVERVIEW_KEY, dirty))),
    );
    // Discard body-only edit fan-out; the structural contract is about the
    // quiescence split that follows.
    quiescenceFrameTypes.length = 0;

    // Quiesce → the server splits the section live and broadcasts the new topology.
    await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
    await session.enqueue(() => undefined);

    // The structural split reached A as a live-section frame carrying state (no
    // commit needed), and the quiescence action sent no raw structural Yjs frame.
    expect(structuralFramesToA).toBeGreaterThan(0);
    expect(quiescenceFrameTypes).toContain(MSG_LIVE_SECTIONS_UPDATE);
    expect(quiescenceFrameTypes).not.toContain(MSG_YJS_UPDATE);

    // Resolve the post-split layout to learn the new sibling's fragment key.
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, session.generator.getCurrentProposalId());
    const sibling = layout.find((e) => e.heading === "Second Section")!;
    expect(sibling).toBeDefined();
    expect(sibling.fragmentKey).not.toBe(OVERVIEW_KEY);

    // Read A's replica through a store keyed on the POST-split fragment keys (which
    // now include the sibling). A must have ADOPTED the new fragment...
    const peerAStore = new LiveFragmentStringsStore(
      peerA,
      session.liveFragments.getFragmentKeys(),
      SAMPLE_DOC_PATH,
    );
    expect(session.liveFragments.getFragmentKeys()).toContain(sibling.fragmentKey);
    expect(peerAStore.readFragmentString(sibling.fragmentKey) as string).toContain("brand new sibling body");

    // ...and the survivor must have SHRUNK on A: the moved-out sibling body is gone,
    // the base body remains.
    const peerOverview = peerAStore.readFragmentString(OVERVIEW_KEY) as string;
    expect(peerOverview).toContain("base overview body");
    expect(peerOverview).not.toContain("brand new sibling body");

    // A converged to the server's authoritative live state for both fragments.
    expect(peerOverview).toBe(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string);
    expect(peerAStore.readFragmentString(sibling.fragmentKey) as string).toBe(
      session.liveFragments.readFragmentString(sibling.fragmentKey) as string,
    );
  });
});
