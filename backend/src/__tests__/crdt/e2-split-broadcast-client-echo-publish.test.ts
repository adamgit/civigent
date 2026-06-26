/**
 * E2: BACKEND GUARD — a client echo during the publish-pause window is ordered
 * correctly and does NOT corrupt the commit.
 *
 * Scope note (why this is GREEN, not a bug reproduction): the user-visible
 * mass-duplication (snapshots/new3.md) is a FRONTEND effect — the REST-driven
 * editor topology does not adopt a live split, so the author keeps typing into the
 * now-stale survivor editor and their keystrokes land in the wrong fragment. A
 * backend-only harness cannot reproduce that mis-routing (it is exercised by the
 * frontend tests E5/E6 once the live-topology-adoption fix exists). What this test
 * DOES guard is the adjacent backend invariant people assumed was the hazard: in
 * the real transport a client keeps SENDING during the pause window — after it
 * receives the split broadcast it round-trips its editor and echoes a `YJS_UPDATE`
 * back BEFORE its `doc_publish_ready` ack. This injects exactly that and proves the
 * backend handles it correctly.
 *
 * Invariants (spec 10 §Readiness ordering invariant; spec 05 §Structural
 * Normalization): the mid-pause edit is ordered BEFORE the finalize snapshot (it
 * reaches canonical), and the commit stays correct — exactly ONE `Second Section`
 * heading path (no duplicate), with the survivor's body intact.
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
import { encodeUpdate, decodeMessage, MSG_YJS_UPDATE } from "../../ws/crdt-ws-frames.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import { readSection } from "../../storage/section-reader.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";
import { SectionRef } from "../../domain/section-ref.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const EDITOR_SOCKET = "editor-sock-1";

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

describe("E2 (backend guard): client echo during the publish-pause window", () => {
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

  it("a mid-pause client update is ordered before finalize and does not duplicate the split heading", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Count the frames the server fans out to the editor so we can prove the
    // injection happens AFTER the split broadcast (and the pause-start frame).
    let framesToEditor = 0;
    const editor = registerFakeEditorSocketForTest(SAMPLE_DOC_PATH, EDITOR_SOCKET, (data) => {
      const decoded = decodeMessage(data);
      if (decoded?.type === MSG_YJS_UPDATE) framesToEditor += 1;
    });
    disposers.push(editor.dispose);

    // 1) The author types a SAME-LEVEL (`##`) sibling heading into Overview.
    const dirty =
      "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent;
    await handleMessageForTest(
      editor.socket,
      editor.state,
      Buffer.from(encodeUpdate(buildClientUpdate(session, OVERVIEW_KEY, dirty))),
    );
    expect(session.generator.hasCurrentProposal()).toBe(true);

    // 2) Quiesce → split normalization (broadcasts the new state) + off-lane pause.
    await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
    await session.enqueue(() => undefined);
    // The off-lane publish establishes the pause one microtask after the quiescence
    // command returns; the split path lengthens that chain, so pump until it is up.
    for (let i = 0; i < 200 && !session.publishPause.isActive(); i++) {
      await vi.advanceTimersByTimeAsync(1);
      await session.enqueue(() => undefined);
    }
    expect(session.publishPause.isActive()).toBe(true);
    // The split was actually broadcast to the editor before we inject the echo.
    expect(framesToEditor).toBeGreaterThan(0);

    // 3) DURING the pause window (after the split broadcast, before the ack) the
    //    client echoes a real YJS_UPDATE — it keeps editing the survivor body. The
    //    Overview fragment on the server is now the leaf "## Overview\n\nbase
    //    overview body"; the echo appends a sentence (NO new heading).
    const continued =
      "## Overview\n\nbase overview body\n\nmore overview text during pause" as FragmentContent;
    await handleMessageForTest(
      editor.socket,
      editor.state,
      Buffer.from(encodeUpdate(buildClientUpdate(session, OVERVIEW_KEY, continued))),
    );

    // 4) Now the client acks readiness (off the lane, as the post-C2 handler does);
    //    the finalize is enqueued BEHIND the mid-pause update (FIFO lane ordering).
    session.publishPause.markReady(EDITOR_SOCKET);
    for (let i = 0; i < 50 && session.generator.hasCurrentProposal(); i++) {
      await vi.advanceTimersByTimeAsync(1);
    }
    await session.enqueue(() => undefined);
    expect(session.generator.hasCurrentProposal()).toBe(false);

    // Ordering: the mid-pause edit reached canonical (it was applied before the
    // finalize snapshot), and the survivor kept its base body.
    const canonicalOverview = await readSection(SAMPLE_DOC_PATH, ["Overview"]);
    expect(canonicalOverview).toContain("base overview body");
    expect(canonicalOverview).toContain("more overview text during pause");
    // The survivor body must NOT carry a re-embedded sibling heading.
    expect(canonicalOverview).not.toContain("## Second Section");

    // Correctness: the promoted sibling is present EXACTLY once — no duplicate
    // heading-path slipped in via the mid-pause echo. (This is the BACKEND half of
    // the duplication question; the new3.md mass-duplication itself is frontend
    // keystroke-misrouting, guarded by E5/E6 — see the header scope note.)
    expect(await readSection(SAMPLE_DOC_PATH, ["Second Section"])).toContain("brand new sibling body");
    const headingPaths = await CanonicalReader.open().listHeadingPaths(SAMPLE_DOC_PATH);
    const secondSectionCount = headingPaths.filter(
      (p) => SectionRef.headingKey(p) === SectionRef.headingKey(["Second Section"]),
    ).length;
    expect(secondSectionCount).toBe(1);
    // And no path appears twice overall.
    const keys = headingPaths.map((p) => SectionRef.headingKey(p));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
