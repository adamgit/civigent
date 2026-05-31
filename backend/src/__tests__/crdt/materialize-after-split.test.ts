/**
 * MW-16: a SECOND materializeEdit() after a structural-dirty SPLIT must succeed.
 *
 * After an author types an embedded heading into a fragment and `materializeEdit()`
 * splits it into a body-holder + a new section, the live document layout
 * (`resolveLiveSectionLayout` / `forEachSection`) emits the nested body-holder as
 * `{ headingPath: ["Overview"], heading: "", level: 0 }`. Re-snapshotting that into
 * the proposal via `ProposalEditor.writeSection(docPath, ["Overview"], "", body)`
 * USED to throw "targeting a headed section but missing the section heading"
 * (`content-layer.ts validateUpsertHeadingArgument`).
 *
 * Fixed: the materialize/upsert contract now round-trips a nested body-holder as a
 * body-only write to its parent section, preserving the parent heading and its
 * children. This test FAILS (throws) without that fix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { armQuiescenceTimer } from "../../ws/crdt-ws-coordinator.js";
import { resolveLiveSectionLayout } from "../../crdt/live-section-layout.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";
import type { FragmentContent } from "../../storage/section-formatting.js";

const WRITER = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";

async function openSession(): Promise<DocSession> {
  const baseHead = await getHeadSha(getDataRoot());
  return acquireDocSession(SAMPLE_DOC_PATH, WRITER.id, baseHead, WRITER, "sock-1");
}

async function drainLane(session: DocSession): Promise<void> {
  await session.enqueue(() => undefined);
}

async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await drainLane(session);
}

describe("MW-16: materialize after a structural-dirty split", () => {
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

  it("a second (and third) materializeEdit() after a split does not throw and preserves the body-holder", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Author types an EMBEDDED heading inside the Overview fragment, then
    // materializes — this splits Overview into a body-holder + New Sub.
    const dirty =
      "## Overview\n\nbase overview body\n\n### New Sub\n\nbrand new sub body" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, dirty);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    const proposalId = await session.generator.materializeEdit();

    // Settle the split into the live Y.Doc (the body-holder fragment is born).
    await fireQuiescence(session);

    void proposalId;

    // SECOND materialize — re-snapshots the post-split layout, which now contains
    // the nested body-holder { headingPath:["Overview"], heading:"", level:0 }.
    // Pre-fix: throws "targeting a headed section but missing the section heading".
    const secondId = await session.generator.materializeEdit();

    // THIRD materialize — must remain stable (still does not throw).
    const thirdId = await session.generator.materializeEdit();
    expect(thirdId).toBe(secondId);

    // The proposal content tree is correct: Overview retains its body-holder body
    // and its New Sub child.
    const { ProposalReader } = await import("../../storage/proposal-reader.js");
    const reader = ProposalReader.open(thirdId, "inprogress");
    const overviewBody = (await reader.readSection(SAMPLE_DOC_PATH, ["Overview"])) as unknown as string;
    expect(overviewBody).toContain("base overview body");
    expect(overviewBody).not.toContain("brand new sub body");
    const subBody = (await reader.readSection(SAMPLE_DOC_PATH, ["Overview", "New Sub"])) as unknown as string;
    expect(subBody).toContain("brand new sub body");

    // The live layout still resolves the body-holder + New Sub + Timeline.
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, thirdId);
    const headings = layout.map((e) => e.heading);
    expect(headings).toContain("New Sub");
    expect(headings).toContain("Timeline");
    expect(
      layout.some((e) => e.headingPath.length === 1 && e.headingPath[0] === "Overview" && e.heading === ""),
    ).toBe(true);
  });
});
