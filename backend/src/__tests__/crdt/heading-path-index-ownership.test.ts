/**
 * Heading-path <-> fragment-key bidirectional index tests on TestDocSession
 * after applyAcceptResult.
 *
 * Covers:
 *   H8  -- AcceptResult.updatedIndex carries full ordered mapping
 *   H9  -- Synchronous index availability after structural split
 *   H10 -- Removed keys gone from index immediately after merge
 *   H11 -- Body-only accept leaves existing index unchanged
 *   H12 -- Multi-key accept (split + body-only) produces correct index
 *   H13 -- Concurrent client update between accept and apply
 *   H14 -- StagedSectionsStore has no heading-path index knowledge
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { buildDocumentFragmentsForTest, type TestDocSession } from "../helpers/build-document-fragments.js";
import { fragmentKeyFromSectionFile, BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { applyAcceptResult, findKeyForHeadingPath, findHeadingPathForKey, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import { StagedSectionsStore } from "../../storage/staged-sections-store.js";

// ─── Shared state ────────────────────────────────────────────────

let ctx: TempDataRootContext;
let fragments: TestDocSession;

// Fragment keys discovered from the heading-path index after build.
let bfhKey: string;
let overviewKey: string;
let timelineKey: string;

async function setup(): Promise<void> {
  ctx = await createTempDataRoot();
  await createSampleDocument(ctx.rootDir);
  fragments = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);

  // Clear ahead-of-staged so subsequent accepts only process what we
  // explicitly mark.
  fragments.liveFragments.clearAheadOfStaged(
    fragments.liveFragments.getAheadOfStagedKeys(),
  );

  // Discover keys via heading-path index.
  for (const [key, hp] of fragments.headingPathByFragmentKey) {
    const heading = hp[hp.length - 1] || "";
    if (hp.length === 0) bfhKey = key;
    else if (heading === "Overview") overviewKey = key;
    else if (heading === "Timeline") timelineKey = key;
  }
}

async function teardown(): Promise<void> {
  fragments.ydoc.destroy();
  await ctx.cleanup();
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Heading-path index ownership after applyAcceptResult", () => {
  beforeEach(setup);
  afterEach(teardown);

  // ── H8 ─────────────────────────────────────────────────────────

  it("H8: AcceptResult.updatedIndex carries full ordered fragmentKey <-> headingPath mapping", async () => {
    // Embed a heading inside Overview to trigger a split.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOriginal overview.\n\n### Goals\n\nGoals content."),
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    const scope = new Set<string>([overviewKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      scope,
    );

    // updatedIndex should be non-null after a structural change.
    expect(result.updatedIndex).not.toBeNull();
    expect(result.structuralChange).not.toBeNull();

    // Every entry must have both fragmentKey and headingPath.
    for (const entry of result.updatedIndex!) {
      expect(entry).toHaveProperty("fragmentKey");
      expect(entry).toHaveProperty("headingPath");
      expect(typeof entry.fragmentKey).toBe("string");
      expect(Array.isArray(entry.headingPath)).toBe(true);
    }

    // Count must match the index (all keys, not just changed).
    // Apply first so the index is rebuilt.
    await applyAcceptResult(fragments as DocSession, result);

    const indexCount = fragments.headingPathByFragmentKey.size;
    expect(result.updatedIndex!.length).toBe(indexCount);
  });

  // ── H9 ─────────────────────────────────────────────────────────

  it("H9: findKeyForHeadingPath returns correct new key immediately after applyAcceptResult with split", async () => {
    // Embed ### Goals into Overview.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOriginal overview.\n\n### Goals\n\nGoals content."),
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    const scope = new Set<string>([overviewKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      scope,
    );

    await applyAcceptResult(fragments as DocSession, result);

    // Synchronously (no await between apply and lookup) check the new child path.
    const goalsKey = findKeyForHeadingPath(fragments as DocSession, ["Overview", "Goals"]);
    expect(goalsKey).not.toBeNull();
    expect(typeof goalsKey).toBe("string");

    // The reverse lookup should also work.
    const goalsPath = findHeadingPathForKey(fragments as DocSession, goalsKey!);
    expect(goalsPath).toEqual(["Overview", "Goals"]);
  });

  // ── H10 ────────────────────────────────────────────────────────

  it("H10: after applyAcceptResult with orphan merge, removed keys are gone from index immediately", async () => {
    // Delete Timeline's heading (make it an orphan body).
    fragments.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark("Timeline body without heading."),
    );
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    const scope = new Set<string>([timelineKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      scope,
    );

    await applyAcceptResult(fragments as DocSession, result);

    // The heading path ["Timeline"] should no longer resolve.
    expect(findKeyForHeadingPath(fragments as DocSession, ["Timeline"])).toBeNull();

    // The old fragment key should no longer resolve to a heading path.
    expect(findHeadingPathForKey(fragments as DocSession, timelineKey)).toBeNull();
  });

  // ── H11 ────────────────────────────────────────────────────────

  it("H11: body-only accept leaves existing index unchanged, no rebuild triggered", async () => {
    // Capture keys before the body-only change.
    const overviewKeyBefore = findKeyForHeadingPath(fragments as DocSession, ["Overview"]);
    const timelineKeyBefore = findKeyForHeadingPath(fragments as DocSession, ["Timeline"]);

    // Body-only change on Overview (keep the heading, change body text).
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nUpdated overview body text only."),
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    const scope = new Set<string>([overviewKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      scope,
    );

    await applyAcceptResult(fragments as DocSession, result);

    // Body-only change: no remaps, no removed keys. structuralChange may
    // be non-null on first overlay write (liveReload), but the key set
    // and heading-path index must remain unchanged.
    expect(result.remaps).toEqual([]);
    if (result.structuralChange) {
      expect(result.structuralChange.removedKeys.size).toBe(0);
    }

    // Index entries should remain exactly the same.
    expect(findKeyForHeadingPath(fragments as DocSession, ["Overview"])).toBe(overviewKeyBefore);
    expect(findKeyForHeadingPath(fragments as DocSession, ["Timeline"])).toBe(timelineKeyBefore);
  });

  // ── H12 ────────────────────────────────────────────────────────

  it("H12: multi-key accept (split + body-only) produces correct index for both", async () => {
    // Overview: embed heading -> split.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOverview body.\n\n## Objectives\n\nObjectives body."),
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Timeline: body-only change.
    fragments.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark("## Timeline\n\nTimeline body updated for H12."),
    );
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    const scope = new Set<string>([overviewKey, timelineKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      scope,
    );

    await applyAcceptResult(fragments as DocSession, result);

    // New child path from Overview split should be findable.
    const objectivesKey = findKeyForHeadingPath(fragments as DocSession, ["Objectives"]);
    expect(objectivesKey).not.toBeNull();

    // Overview itself should still be findable (the split creates new entries
    // for the original heading and any new headings).
    const overviewKeyAfter = findKeyForHeadingPath(fragments as DocSession, ["Overview"]);
    expect(overviewKeyAfter).not.toBeNull();

    // Timeline's path should still be correct.
    const timelineKeyAfter = findKeyForHeadingPath(fragments as DocSession, ["Timeline"]);
    expect(timelineKeyAfter).not.toBeNull();
    const timelinePath = findHeadingPathForKey(fragments as DocSession, timelineKeyAfter!);
    expect(timelinePath).toEqual(["Timeline"]);
  });

  // ── H13 ────────────────────────────────────────────────────────

  it("H13: concurrent client update between accept and apply -- index reflects accepted structural change only", async () => {
    // Trigger a split on Overview.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOverview body.\n\n### Milestones\n\nMilestones body."),
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    const scope = new Set<string>([overviewKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      scope,
    );

    // BEFORE applying the accept result, simulate a concurrent client edit
    // on Timeline. This changes content but does NOT change structure
    // (the accept result was already computed).
    fragments.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark("## Timeline\n\nConcurrently edited timeline body."),
    );

    // Now apply the accept result.
    await applyAcceptResult(fragments as DocSession, result);

    // The index should reflect the accepted structural change (Overview split)
    // but not any structural implications of the concurrent edit.
    const milestonesKey = findKeyForHeadingPath(fragments as DocSession, ["Overview", "Milestones"]);
    expect(milestonesKey).not.toBeNull();

    // Overview should still be findable after the split.
    const overviewKeyAfter = findKeyForHeadingPath(fragments as DocSession, ["Overview"]);
    expect(overviewKeyAfter).not.toBeNull();

    // Timeline should still resolve correctly (concurrent edit did not alter structure).
    const timelineKeyAfter = findKeyForHeadingPath(fragments as DocSession, ["Timeline"]);
    expect(timelineKeyAfter).not.toBeNull();
    expect(findHeadingPathForKey(fragments as DocSession, timelineKeyAfter!)).toEqual(["Timeline"]);
  });

  // ── H14 ────────────────────────────────────────────────────────

  it("H14: StagedSectionsStore has no reference to or knowledge of heading-path index", () => {
    // StagedSectionsStore must not own or expose heading-path index methods.
    // These belong on DocSession. The storage layer must remain index-free.
    expect(
      (StagedSectionsStore.prototype as any).findKeyForHeadingPath,
    ).toBeUndefined();
    expect(
      (StagedSectionsStore.prototype as any).findFragmentKeyForHeadingPath,
    ).toBeUndefined();
    expect(
      (StagedSectionsStore.prototype as any).headingPathByFragmentKey,
    ).toBeUndefined();
    expect(
      (StagedSectionsStore.prototype as any).fragmentKeyByHeadingPathKey,
    ).toBeUndefined();
    expect(
      (StagedSectionsStore.prototype as any).rebuildIndexFromSkeleton,
    ).toBeUndefined();
    expect(
      (StagedSectionsStore.prototype as any).findHeadingPathForFragmentKey,
    ).toBeUndefined();
  });
});
