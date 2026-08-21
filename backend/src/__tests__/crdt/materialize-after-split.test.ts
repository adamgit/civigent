/**
 * MW-16: a SECOND materializeEdit() after a structural-dirty SPLIT must succeed.
 *
 * After an author types an embedded heading into a fragment and `materializeEdit()`
 * splits it into a body-holder + a new section, the live document layout
 * (`resolveLiveSectionLayout` / `forEachVisibleSection`) emits the nested
 * body-holder with its PARENT's VISIBLE heading + level (Option A:
 * `{ headingPath: ["Overview"], heading: "Overview", level: <##> }`), and its live
 * fragment RETAINS the `## Overview` heading line — NOT the literal `("", 0)`
 * body-holder shape the live path used to report. Re-snapshotting still round-trips
 * correctly (preserving the parent heading + its children).
 *
 * Fixed: the materialize/upsert contract round-trips the body-holder as a body
 * write to its parent section, preserving the parent heading and its children.
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
    // the nested body-holder reported (Option A) with the parent's VISIBLE heading
    // { headingPath:["Overview"], heading:"Overview", level:<##> }.
    // Pre-fix: threw "targeting a headed section but missing the section heading".
    const secondId = await session.generator.materializeEdit();

    // THIRD materialize — must remain stable (still does not throw).
    const thirdId = await session.generator.materializeEdit();
    expect(thirdId).toBe(secondId);

    // The proposal content tree is correct: Overview retains its body-holder body
    // and its New Sub child.
    const { ProposalReader } = await import("../../storage/proposal-reader.js");
    const reader = ProposalReader.open(thirdId, "inprogress");
    const overviewBody = (await reader.readEffectiveSection(SAMPLE_DOC_PATH, ["Overview"])) as unknown as string;
    expect(overviewBody).toContain("base overview body");
    expect(overviewBody).not.toContain("brand new sub body");
    const subBody = (await reader.readEffectiveSection(SAMPLE_DOC_PATH, ["Overview", "New Sub"])) as unknown as string;
    expect(subBody).toContain("brand new sub body");

    // The live layout still resolves the body-holder + New Sub + Timeline.
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, thirdId);
    const headings = layout.map((e) => e.heading);
    expect(headings).toContain("New Sub");
    expect(headings).toContain("Timeline");
    // Option A: the Overview body-holder is reported with the parent's VISIBLE
    // heading + level (same `##` level as a top-level sibling like Timeline), NOT
    // the literal `("", 0)` shape.
    const overviewBodyHolder = layout.find(
      (e) => e.headingPath.length === 1 && e.headingPath[0] === "Overview",
    );
    expect(overviewBodyHolder).toBeDefined();
    expect(overviewBodyHolder!.heading).toBe("Overview");
    const timelineEntry = layout.find((e) => e.heading === "Timeline")!;
    expect(overviewBodyHolder!.headingLevel).toBe(timelineEntry.headingLevel);
    expect(overviewBodyHolder!.headingLevel).toBeGreaterThan(0);

    // …and the survivor's LIVE fragment RETAINS its heading line (Option A: every
    // live fragment carries its heading; the body-holder is no longer body-only).
    const { buildLiveSeedContentMap } = await import("../../crdt/live-section-layout.js");
    const seed = await buildLiveSeedContentMap(SAMPLE_DOC_PATH, thirdId);
    const overviewFragment = seed.get(overviewBodyHolder!.fragmentKey) as unknown as string;
    expect(overviewFragment.startsWith(`${"#".repeat(overviewBodyHolder!.headingLevel)} Overview`)).toBe(true);
    expect(overviewFragment).toContain("base overview body");
  });

  it("a second (and third) materializeEdit() after a SIBLING split does not throw and preserves both sections", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Author types a SECOND SAME-LEVEL (`##`) heading inside the Overview fragment,
    // then materializes — this splits Overview into a LEAF survivor + a new SIBLING
    // section (the survivor keeps its heading, so the body-holder branch of
    // `computeStructuralSplitPlan` is NOT taken — a distinct code path from the
    // nested-child case above).
    const dirty =
      "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, dirty);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();

    // Settle the split into the live Y.Doc (the new sibling fragment is born).
    await fireQuiescence(session);

    // SECOND + THIRD materialize — re-snapshots the post-split layout (a leaf
    // Overview + a top-level Second Section). Must remain stable and not throw.
    const secondId = await session.generator.materializeEdit();
    const thirdId = await session.generator.materializeEdit();
    expect(thirdId).toBe(secondId);

    // The proposal content tree is correct: Overview keeps its (leaf) body, and the
    // new Second Section is a TOP-LEVEL sibling carrying the moved-out body.
    const { ProposalReader } = await import("../../storage/proposal-reader.js");
    const reader = ProposalReader.open(thirdId, "inprogress");
    const overviewBody = (await reader.readEffectiveSection(SAMPLE_DOC_PATH, ["Overview"])) as unknown as string;
    expect(overviewBody).toContain("base overview body");
    expect(overviewBody).not.toContain("brand new sibling body");
    const siblingBody = (await reader.readEffectiveSection(SAMPLE_DOC_PATH, ["Second Section"])) as unknown as string;
    expect(siblingBody).toContain("brand new sibling body");

    // The live layout resolves Overview (leaf) + Second Section + Timeline.
    const layout = await resolveLiveSectionLayout(SAMPLE_DOC_PATH, thirdId);
    const headings = layout.map((e) => e.heading);
    expect(headings).toContain("Overview");
    expect(headings).toContain("Second Section");
    expect(headings).toContain("Timeline");
    // The survivor stays a LEAF — there is NO heading="" body-holder for Overview.
    expect(
      layout.some((e) => e.headingPath.length === 1 && e.headingPath[0] === "Overview" && e.heading === ""),
    ).toBe(false);
    const sibling = layout.find((e) => e.heading === "Second Section")!;
    expect(sibling.headingPath).toEqual(["Second Section"]);
  });
});
