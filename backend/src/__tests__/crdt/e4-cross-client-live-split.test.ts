/**
 * E4: cross-client LIVE split (backend portion).
 *
 * Client A has the document mounted; client B types a same-level (`##`) sibling
 * heading into a section. At quiescence the server splits the section
 * structurally and fans the new live topology out to EVERY socket (spec 05
 * §Structural Normalization: "the YJS_UPDATE delta produced by the server IS the
 * broadcast"; structural changes arrive as ordinary YJS_UPDATE deltas, not a
 * removed `doc:structure-changed` event).
 *
 * Asserts the cross-client adoption that the live-split fix must guarantee: A's
 * Y.Doc receives the NEW sibling fragment AND the survivor shrinks (the moved-out
 * body is gone from A's copy of the survivor) — purely from the live broadcast,
 * with NO commit / `content:committed` required. The live-topology signal in the
 * current design is the YJS_UPDATE delta itself; this is the seam where an
 * explicit topology event would also be asserted if the fix introduces one.
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
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { encodeUpdate, decodeMessage, MSG_YJS_UPDATE } from "../../ws/crdt-ws-frames.js";
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

    // Client A: mounted. A replica Y.Doc tracks exactly the YJS_UPDATE frames the
    // server fans out to A's socket.
    const peerA = new Y.Doc();
    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(session.ydoc));
    let framesToA = 0;
    const a = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, "sock-A", (data) => {
      const decoded = decodeMessage(data);
      if (decoded?.type === MSG_YJS_UPDATE) {
        framesToA += 1;
        Y.applyUpdate(peerA, decoded.payload);
      }
    });
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

    // Quiesce → the server splits the section live and broadcasts the new topology.
    await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
    await session.enqueue(() => undefined);

    // The live-topology signal reached A as YJS_UPDATE delta(s) (no commit needed).
    expect(framesToA).toBeGreaterThan(0);

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
