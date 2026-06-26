/**
 * Live structural normalization at per-section quiescence (split path).
 *
 * Once a document goes quiet, `runQuiescenceCommand` → `normalizeQuiescedStructure`
 * classifies each dirty fragment and applies the identity-preserving structural
 * appliers (`crdt/structural-appliers.ts`). This suite covers the SPLIT case:
 *
 *  (1) an author types an embedded heading into the Overview fragment
 *      ("### New Sub"). The live Y.Doc must gain the extra section fragment with
 *      bodies correct, and — via WS-0 survivor id-reuse — the Overview body-holder
 *      must KEEP the `section::overview` key (no re-key).
 *  (1b) a section NOT directly restructured by the split keeps its Yjs struct
 *      identity (cursors survive).
 *
 * The MERGE / RENAME / level-change identity paths are covered in
 * `merge-rename-identity.test.ts`; the survivor-identity split assertion is in
 * `split-identity-preservation.test.ts`.
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

/** Advance fake timers past the quiescence threshold and drain the actor lane. */
async function fireQuiescence(session: DocSession): Promise<void> {
  armQuiescenceTimer(session);
  await vi.advanceTimersByTimeAsync(session.generator.publishTriggerPolicy.quiescenceThresholdMs + 50);
  await drainLane(session);
}

describe("MW-15: live structural normalization (split / orphan-merge)", () => {
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

  it("(1) SPLIT: an embedded heading becomes a real live section fragment", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Baseline: three live fragments (BFH, Overview, Timeline), no New Sub.
    expect(session.liveFragments.getFragmentKeys()).toEqual([
      "section::__beforeFirstHeading__",
      "section::overview",
      "section::timeline",
    ]);

    // Author types an EMBEDDED heading inside the Overview fragment.
    const dirty =
      "## Overview\n\nbase overview body\n\n### New Sub\n\nbrand new sub body" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, dirty);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();

    await fireQuiescence(session);

    // The proposal layout (authoritative) split Overview into a body-holder +
    // a New Sub section. The LIVE Y.Doc must now hold a fragment for EACH layout
    // entry — i.e. the split happened live.
    const layout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    const headings = layout.map((e) => e.heading);
    expect(headings).toContain("New Sub");
    expect(headings).toContain("Timeline");

    const liveKeys = new Set(session.liveFragments.getFragmentKeys());
    for (const entry of layout) {
      expect(liveKeys.has(entry.fragmentKey)).toBe(true);
    }

    // The split section carries the correct body LIVE.
    const newSub = layout.find((e) => e.heading === "New Sub")!;
    const newSubLive = session.liveFragments.readFragmentString(newSub.fragmentKey) as string;
    expect(newSubLive).toContain("brand new sub body");
    expect(newSubLive).toContain("New Sub");

    // The Overview body-holder fragment keeps the base body but NOT the sub
    // content (the sub split out into its own fragment).
    const overviewBodyHolder = layout.find(
      (e) => e.headingPath.length === 1 && e.headingPath[0] === "Overview" && e.heading !== "New Sub",
    )!;
    const overviewLive = session.liveFragments.readFragmentString(overviewBodyHolder.fragmentKey) as string;
    expect(overviewLive).toContain("base overview body");
    expect(overviewLive).not.toContain("brand new sub body");
    // Option A: the Overview body-holder is reported with the parent's VISIBLE
    // heading "Overview" (not `heading:""`), and its LIVE fragment RETAINS the
    // `## Overview` heading line — the bug-3 fix (mounting the parent shows its
    // heading), not the old body-only body-holder.
    expect(overviewBodyHolder.heading).toBe("Overview");
    expect(overviewLive.startsWith("## Overview")).toBe(true);

    // WS-0 (split survivor identity): the split survivor KEEPS its section-file
    // id. Overview became a sub-skeleton parent, so its body now lives in a
    // body-holder that REUSES the original `section::overview` id — the live
    // fragment identity is preserved across the split (no re-key), which is the
    // whole point of WS-0. (Pre-WS-0 the survivor was minted a fresh id and the
    // old key was reconciled away.)
    expect(overviewBodyHolder.fragmentKey).toBe(OVERVIEW_KEY);
    expect(session.liveFragments.getFragmentKeys()).toContain(OVERVIEW_KEY);
  });

  it("(1-sibling) SPLIT: a SAME-LEVEL embedded heading becomes a top-level sibling live fragment", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Baseline: three live fragments (BFH, Overview, Timeline), no sibling yet.
    expect(session.liveFragments.getFragmentKeys()).toEqual([
      "section::__beforeFirstHeading__",
      "section::overview",
      "section::timeline",
    ]);

    // Author types a SECOND SAME-LEVEL (`##`) heading inside the Overview fragment.
    const dirty =
      "## Overview\n\nbase overview body\n\n## Second Section\n\nbrand new sibling body" as FragmentContent;
    session.liveFragments.replaceFragmentString(OVERVIEW_KEY, dirty);
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();

    await fireQuiescence(session);

    // The proposal layout split Overview into a LEAF Overview + a top-level
    // Second Section sibling. The LIVE Y.Doc must hold a fragment for EACH entry.
    const layout = await resolveLiveSectionLayout(
      SAMPLE_DOC_PATH,
      session.generator.getCurrentProposalId(),
    );
    const headings = layout.map((e) => e.heading);
    expect(headings).toContain("Second Section");
    expect(headings).toContain("Overview");
    expect(headings).toContain("Timeline");

    const liveKeys = new Set(session.liveFragments.getFragmentKeys());
    for (const entry of layout) {
      expect(liveKeys.has(entry.fragmentKey)).toBe(true);
    }

    // The new sibling carries the moved-out body LIVE, at the top level.
    const sibling = layout.find((e) => e.heading === "Second Section")!;
    expect(sibling.level).toBe(2);
    expect(sibling.headingPath).toEqual(["Second Section"]);
    const siblingLive = session.liveFragments.readFragmentString(sibling.fragmentKey) as string;
    expect(siblingLive).toContain("brand new sibling body");
    expect(siblingLive).toContain("Second Section");

    // The survivor stays a LEAF (keeps its "Overview" heading — NOT a heading=""
    // body-holder) and REUSES the original `section::overview` id (no re-key).
    const survivor = layout.find((e) => e.fragmentKey === OVERVIEW_KEY)!;
    expect(survivor.heading).toBe("Overview");
    expect(survivor.level).toBe(2);
    expect(survivor.headingPath).toEqual(["Overview"]);
    const survivorLive = session.liveFragments.readFragmentString(OVERVIEW_KEY) as string;
    expect(survivorLive).toContain("base overview body");
    expect(survivorLive).not.toContain("brand new sibling body");
    // There is NO heading="" body-holder for Overview in a sibling split.
    expect(
      layout.some((e) => e.headingPath.length === 1 && e.headingPath[0] === "Overview" && e.heading === ""),
    ).toBe(false);
  });

  it("(1b) SPLIT preserves the Yjs identity of an UNAFFECTED section (cursors survive)", async () => {
    vi.useFakeTimers();
    const session = await openSession();

    // Capture the identity of Timeline's first Yjs struct BEFORE the split. A
    // cursor / RelativePosition anchors to this struct's id; if the reconcile
    // clobbers Timeline (clear+recreate), the id changes and the cursor is lost.
    const timelineFrag = session.ydoc.getXmlFragment("section::timeline");
    expect(timelineFrag.length).toBeGreaterThan(0);
    const idBefore = ((timelineFrag.get(0) as unknown as { _item?: { id: { client: number; clock: number } } })._item)!.id;
    expect(idBefore).toBeDefined();

    // Split Overview (a DIFFERENT section) — this triggers a structural reconcile.
    session.liveFragments.replaceFragmentString(
      OVERVIEW_KEY,
      "## Overview\n\nbase overview body\n\n### New Sub\n\nbrand new sub body" as FragmentContent,
    );
    session.fragmentLastActivity.set(OVERVIEW_KEY, Date.now());
    await session.generator.materializeEdit();
    await fireQuiescence(session);

    // Sanity: the split actually happened (New Sub is now live).
    const liveKeys = session.liveFragments.getFragmentKeys();
    expect(liveKeys).toContain("section::timeline");

    // Timeline was NOT directly restructured, so the reconcile must have SKIPPED
    // rewriting it — its first Yjs struct keeps the SAME id (identity preserved).
    const idAfter = ((session.ydoc.getXmlFragment("section::timeline").get(0) as unknown as { _item?: { id: { client: number; clock: number } } })._item)!.id;
    expect({ client: idAfter.client, clock: idAfter.clock }).toEqual({ client: idBefore.client, clock: idBefore.clock });
  });
});
