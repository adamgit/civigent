/**
 * WS-7: merge-target resolution edge cases, driven end-to-end through the real
 * DocSession + quiescence pipeline. Recovers the INTENT of the deleted
 * `heading-deletion-merge-target` oracle (which drove the removed FragmentStore /
 * applyAcceptResult internals) against the new identity-preserving merge applier.
 *
 * Covered: a heading deletion folds the orphan body onto the PRECEDING section in
 * document order — whether that predecessor is another headed section or the
 * before-first-heading (BFH) preamble.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { markdownToJSON } from "@ks/milkdown-serializer";
import { updateYFragment } from "y-prosemirror";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { armQuiescenceTimer } from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getBackendSchema } from "../../crdt/ydoc-fragments.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const BFH_KEY = "section::__beforeFirstHeading__";
const OVERVIEW_KEY = "section::overview";

function deleteHeadingViaMinimalDiff(session: DocSession, key: string, bodyOnlyMarkdown: string): void {
  const frag = session.ydoc.getXmlFragment(key);
  const target = getBackendSchema().nodeFromJSON(markdownToJSON(bodyOnlyMarkdown));
  session.ydoc.transact(() => updateYFragment(session.ydoc, frag, target, { mapping: new Map(), isOMark: new Map() }));
}

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await session.enqueue(() => undefined);
}

describe("WS-7: merge-target resolution edge cases", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });
  afterEach(async () => {
    destroyAllSessions();
    vi.useRealTimers();
    await ctx.cleanup();
  });

  it("deleting the FIRST headed section folds its body into the BFH preamble", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Delete the Overview heading (Overview is the first headed section; its
    // predecessor in document order is the BFH preamble).
    deleteHeadingViaMinimalDiff(session, OVERVIEW_KEY, "The overview covers our strategic goals.");
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    const proposalId = await session.generator.materializeEdit();

    await fireQuiescence(session);

    // Overview's fragment is gone; its body folded into the BFH preamble.
    expect(session.liveFragments.getFragmentKeys()).not.toContain(OVERVIEW_KEY);
    const bfh = session.liveFragments.readFragmentString(BFH_KEY) as string;
    expect(bfh).toContain("This is the strategy document preamble.");
    expect(bfh).toContain("The overview covers our strategic goals.");

    // The proposal followed: Overview is gone, Timeline remains.
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, proposalId);
    expect(layout.some((e) => e.heading === "Overview")).toBe(false);
    expect(layout.some((e) => e.heading === "Timeline")).toBe(true);
  });
});
