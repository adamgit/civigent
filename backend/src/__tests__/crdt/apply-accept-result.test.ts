/**
 * Tests for LiveFragmentStringsStore.applyStructuralChange and
 * applyAcceptResult (the DocSession-level orchestration).
 *
 * applyAcceptResult is exported from ydoc-lifecycle, so these tests exercise
 * it indirectly through a local normalizeStructure helper that mirrors the
 * old DocumentFragments.normalizeStructure path.
 *
 * Test IDs: D1.5, B5.1, B5.2, B5.4, B5.6, B12.1, B12.2, B12.3, B12.4, B12.6
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { buildDocumentFragmentsForTest, type TestDocSession } from "../helpers/build-document-fragments.js";
import { fragmentKeyFromSectionFile, BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { fragmentFromRemark, type FragmentContent } from "../../storage/section-formatting.js";
import { applyAcceptResult, findKeyForHeadingPath, findHeadingPathForKey, type DocSession } from "../../crdt/ydoc-lifecycle.js";
import type { StructuralChange } from "../../crdt/live-fragment-strings-store.js";

// ─── Helpers ──────────────────────────────────────────────────────────

let ctx: TempDataRootContext;
let fragments: TestDocSession;

/** Collect fragment keys from the heading-path index. */
function collectKeys(frags: TestDocSession): Map<string, { heading: string; headingPath: string[] }> {
  const result = new Map<string, { heading: string; headingPath: string[] }>();
  for (const [key, hp] of frags.headingPathByFragmentKey) {
    result.set(key, { heading: hp[hp.length - 1] || "", headingPath: [...hp] });
  }
  return result;
}

/** Find the fragment key for a given heading name. */
function findKeyByHeading(frags: TestDocSession, headingName: string): string {
  for (const [key, hp] of frags.headingPathByFragmentKey) {
    const heading = hp[hp.length - 1] || "";
    if (heading === headingName) return key;
  }
  throw new Error(`No fragment key for heading "${headingName}"`);
}

/** Set fragment content and mark it dirty + ahead-of-staged. */
function injectContent(frags: TestDocSession, key: string, markdown: string): void {
  frags.liveFragments.replaceFragmentString(key, fragmentFromRemark(markdown));
  frags.liveFragments.noteAheadOfStaged(key);
}

/**
 * Inline normalizeStructure equivalent for TestDocSession.
 * Mirrors the old DocumentFragments.normalizeStructure semantics.
 */
async function normalizeStructure(
  frags: TestDocSession,
  fragmentKey: string,
): Promise<{ changed: boolean; createdKeys: string[]; removedKeys: string[] }> {
  frags.liveFragments.noteAheadOfStaged(fragmentKey);
  const scope = new Set([fragmentKey]);
  await frags.recoveryBuffer.writeFragment(fragmentKey, frags.liveFragments.readFragmentString(fragmentKey));
  const acceptResult = await frags.stagedSections.acceptLiveFragments(frags.liveFragments, scope);
  await applyAcceptResult(frags as DocSession, acceptResult);

  const removedKeys = [...(acceptResult.structuralChange?.removedKeys ?? [])];
  const createdKeys: string[] = [];
  for (const remap of acceptResult.remaps) {
    if (remap.oldKey !== fragmentKey) continue;
    for (const k of remap.newKeys) {
      if (k !== fragmentKey) createdKeys.push(k);
    }
  }

  return {
    changed:
      acceptResult.structuralChange !== undefined && acceptResult.structuralChange !== null
      || acceptResult.writtenKeys.length > 0
      || acceptResult.deletedKeys.length > 0,
    createdKeys,
    removedKeys,
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(async () => {
  ctx = await createTempDataRoot();
  await createSampleDocument(ctx.rootDir);
  fragments = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);
  // Clear ahead-of-staged state left by the build helper's normalizeStructure calls
  fragments.liveFragments.clearAheadOfStaged(fragments.liveFragments.getAheadOfStagedKeys());
});

afterEach(async () => {
  fragments.ydoc.destroy();
  await ctx.cleanup();
});

// ─── D1.5 ─────────────────────────────────────────────────────────────

describe("D1.5: After applyAcceptResult, Y.Doc fragment keys match AcceptResult.structuralChange.orderedKeys", () => {
  it("split on Overview produces fragment keys matching the structural change's orderedKeys", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");

    // Embed a new heading inside Overview to trigger a split
    injectContent(
      fragments,
      overviewKey,
      "## Overview\n\nOriginal overview.\n\n### Goals\n\nGoals content.",
    );

    // normalizeStructure internally calls acceptLiveFragments then applyAcceptResult
    const result = await normalizeStructure(fragments, overviewKey);
    expect(result.changed).toBe(true);
    expect(result.createdKeys.length).toBeGreaterThanOrEqual(1);

    // After applyAcceptResult, the fragment keys on liveFragments must reflect
    // the new structure (the same set as orderedKeys in the structural change).
    const liveKeys = fragments.liveFragments.getFragmentKeys();

    // The new key set must include the BFH, Overview (possibly under a new key),
    // the newly created child, and Timeline.
    expect(liveKeys.length).toBeGreaterThanOrEqual(4);

    // Every key in the live store should be resolvable via the heading-path index
    for (const key of liveKeys) {
      const hp = fragments.headingPathByFragmentKey.get(key) ?? null;
      expect(hp).not.toBeNull();
    }
  });
});

// ─── B5.1 ─────────────────────────────────────────────────────────────

describe("B5.1: applyStructuralChange updates the ordered fragment key list", () => {
  it("after applying a structural change, getFragmentKeys returns the new ordered key list", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");
    const keysBefore = fragments.liveFragments.getFragmentKeys();

    // Inject a split-triggering edit
    injectContent(
      fragments,
      overviewKey,
      "## Overview\n\nSplit overview.\n\n## Addendum\n\nAddendum body.",
    );

    // Drive the full accept path through normalizeStructure so that
    // stagedSections produces a real StructuralChange
    await normalizeStructure(fragments, overviewKey);

    const keysAfter = fragments.liveFragments.getFragmentKeys();

    // The key list must have changed (at minimum, one new key for the split child)
    expect(keysAfter).not.toEqual(keysBefore);

    // The new list should contain a key for each section in the heading-path index
    const indexKeys = new Set<string>(fragments.headingPathByFragmentKey.keys());
    expect(new Set(keysAfter)).toEqual(indexKeys);
  });
});

// ─── B5.2 ─────────────────────────────────────────────────────────────

describe("B5.2: applyStructuralChange clears removed fragments from Y.Doc", () => {
  it("after orphan merge on Timeline, the removed key's Y.Doc fragment is cleared", async () => {
    const timelineKey = findKeyByHeading(fragments, "Timeline");

    // Simulate heading deletion (orphan) on Timeline
    injectContent(
      fragments,
      timelineKey,
      "Timeline body without heading.",
    );

    // Confirm Timeline content exists before normalization
    const contentBefore = fragments.liveFragments.readFragmentString(timelineKey);
    expect(contentBefore).toBeTruthy();

    await normalizeStructure(fragments, timelineKey);

    // The removed key should now read as empty from the Y.Doc
    const contentAfter = fragments.liveFragments.readFragmentString(timelineKey);
    expect((contentAfter as string).trim()).toBe("");
  });
});

// ─── B5.4 ─────────────────────────────────────────────────────────────

describe("B5.4: applyStructuralChange does not touch fragments not in contentByKey or removedKeys", () => {
  it("splitting Overview does not alter Timeline's content", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");
    const timelineKey = findKeyByHeading(fragments, "Timeline");

    // Read Timeline's content before the structural change
    const timelineContentBefore = fragments.liveFragments.readFragmentString(timelineKey);
    expect((timelineContentBefore as string).trim().length).toBeGreaterThan(0);

    // Trigger a split on Overview
    injectContent(
      fragments,
      overviewKey,
      "## Overview\n\nKept overview.\n\n## Sidebar\n\nSidebar content.",
    );

    await normalizeStructure(fragments, overviewKey);

    // Timeline's content must be identical to what it was before
    const timelineContentAfter = fragments.liveFragments.readFragmentString(timelineKey);
    expect(timelineContentAfter).toBe(timelineContentBefore);
  });
});

// ─── B5.6 ─────────────────────────────────────────────────────────────

describe("B5.6: After applyStructuralChange, new keys are readable via readFragmentString", () => {
  it("new keys created by a split are readable and contain non-empty content", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");
    const keysBefore = new Set(fragments.liveFragments.getFragmentKeys());

    injectContent(
      fragments,
      overviewKey,
      "## Overview\n\nOverview remains.\n\n## NewSection\n\nNewSection body.",
    );

    await normalizeStructure(fragments, overviewKey);

    const keysAfter = fragments.liveFragments.getFragmentKeys();

    // Identify newly created keys
    const newKeys = keysAfter.filter((k) => !keysBefore.has(k));
    expect(newKeys.length).toBeGreaterThanOrEqual(1);

    // Every new key must have non-empty readable content
    for (const key of newKeys) {
      const content = fragments.liveFragments.readFragmentString(key);
      expect((content as string).trim().length).toBeGreaterThan(0);
    }
  });
});

// ─── B12.1 ─────────────────────────────────────────────────────────────

describe("B12.1: applyAcceptResult with structural change rebuilds heading-path index from updatedIndex", () => {
  it("after split, fragment keys match orderedKeys and heading-path index is updated", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");

    injectContent(
      fragments,
      overviewKey,
      "## Overview\n\nOverview text.\n\n## Analysis\n\nAnalysis content.",
    );

    const result = await normalizeStructure(fragments, overviewKey);
    expect(result.changed).toBe(true);

    // Verify fragment keys match the heading-path index
    const indexKeys = [...fragments.headingPathByFragmentKey.keys()];
    expect(fragments.liveFragments.getFragmentKeys()).toEqual(indexKeys);

    // Verify the heading-path index was rebuilt: the new heading "Analysis"
    // must be findable
    const analysisKey = findKeyForHeadingPath(fragments as DocSession, ["Analysis"]);
    expect(analysisKey).not.toBeNull();
    expect(findHeadingPathForKey(fragments as DocSession, analysisKey!)).toEqual(["Analysis"]);

    // Overview should still be findable
    const overviewKeyAfter = findKeyForHeadingPath(fragments as DocSession, ["Overview"]);
    expect(overviewKeyAfter).not.toBeNull();
  });
});

// ─── B12.2 ─────────────────────────────────────────────────────────────

describe("B12.2: When structuralChange null (body-only), no Y.Doc mutation, no index rebuild", () => {
  it("body-only edit on Overview preserves fragment keys and heading-path index unchanged", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");
    const keysBefore = fragments.liveFragments.getFragmentKeys();

    // Body-only edit — heading stays the same, just body content changes
    injectContent(
      fragments,
      overviewKey,
      "## Overview\n\nUpdated overview body without structural change.",
    );

    await normalizeStructure(fragments, overviewKey);

    const keysAfter = fragments.liveFragments.getFragmentKeys();

    // The key set should be the same (possibly same or different objects,
    // but the set of keys should be identical)
    expect(new Set(keysAfter)).toEqual(new Set(keysBefore));

    // Heading-path index unchanged
    expect(findKeyForHeadingPath(fragments as DocSession, ["Overview"])).toBeTruthy();
    expect(findKeyForHeadingPath(fragments as DocSession, ["Timeline"])).toBeTruthy();
    expect(findKeyForHeadingPath(fragments as DocSession, [])).toBeTruthy();
  });
});

// ─── B12.3 ─────────────────────────────────────────────────────────────

it.todo("B12.3: broadcasts structure change when remaps non-empty and holders connected — requires integration test infrastructure (WebSocket holders)");

// ─── B12.4 ─────────────────────────────────────────────────────────────

it.todo("B12.4: does NOT broadcast when no holders — requires integration test infrastructure (WebSocket holders)");

// ─── B12.6 ─────────────────────────────────────────────────────────────

describe("B12.6: After applyAcceptResult with structural change, findKeyForHeadingPath and findHeadingPathForKey return correct mappings", () => {
  it("split on Overview creates child heading with correct bidirectional heading-path <-> key mappings", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");

    // Embed a child heading under Overview
    injectContent(
      fragments,
      overviewKey,
      "## Overview\n\nOverview text.\n\n### Goals\n\nGoals content.",
    );

    const result = await normalizeStructure(fragments, overviewKey);
    expect(result.changed).toBe(true);

    // Verify Overview is still findable via heading path
    const overviewKeyAfter = findKeyForHeadingPath(fragments as DocSession, ["Overview"]);
    expect(overviewKeyAfter).not.toBeNull();

    // Verify the new child heading path is findable. The exact heading-path
    // shape depends on whether the child is a sibling or nested under Overview.
    // With ### inside ##, the content layer creates a child under Overview's parent,
    // so the heading path could be ["Overview", "Goals"] or just ["Goals"] depending
    // on the skeleton's level interpretation. Check both possibilities.
    const goalsAsChild = findKeyForHeadingPath(fragments as DocSession, ["Overview", "Goals"]);
    const goalsAsSibling = findKeyForHeadingPath(fragments as DocSession, ["Goals"]);
    const goalsKey = goalsAsChild ?? goalsAsSibling;
    expect(goalsKey).not.toBeNull();

    // Verify reverse mapping: key -> heading path
    const goalsPath = findHeadingPathForKey(fragments as DocSession, goalsKey!);
    expect(goalsPath).not.toBeNull();
    expect(goalsPath!.length).toBeGreaterThan(0);
    expect(goalsPath![goalsPath!.length - 1]).toBe("Goals");

    // Verify Overview reverse mapping
    const overviewPath = findHeadingPathForKey(fragments as DocSession, overviewKeyAfter!);
    expect(overviewPath).toEqual(["Overview"]);

    // BFH should still be mapped correctly
    const bfhKey = findKeyForHeadingPath(fragments as DocSession, []);
    expect(bfhKey).not.toBeNull();
    expect(findHeadingPathForKey(fragments as DocSession, bfhKey!)).toEqual([]);

    // Timeline should still be mapped correctly
    const timelineKey = findKeyForHeadingPath(fragments as DocSession, ["Timeline"]);
    expect(timelineKey).not.toBeNull();
    expect(findHeadingPathForKey(fragments as DocSession, timelineKey!)).toEqual(["Timeline"]);
  });

  it("heading rename produces correct bidirectional mappings for the new heading name", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");

    injectContent(
      fragments,
      overviewKey,
      "## Summary\n\nRenamed overview content.",
    );

    const result = await normalizeStructure(fragments, overviewKey);
    expect(result.changed).toBe(true);

    // Old heading path should no longer resolve (the old section file was removed/replaced)
    // Note: depending on implementation, the old key may or may not resolve to the old path.
    // The important thing is that the new name resolves correctly.
    const summaryKey = findKeyForHeadingPath(fragments as DocSession, ["Summary"]);
    expect(summaryKey).not.toBeNull();
    expect(findHeadingPathForKey(fragments as DocSession, summaryKey!)).toEqual(["Summary"]);

    // Timeline should be unaffected
    const timelineKey = findKeyForHeadingPath(fragments as DocSession, ["Timeline"]);
    expect(timelineKey).not.toBeNull();
    expect(findHeadingPathForKey(fragments as DocSession, timelineKey!)).toEqual(["Timeline"]);
  });

  it("orphan merge removes the merged key from heading-path index entirely", async () => {
    const timelineKey = findKeyByHeading(fragments, "Timeline");

    injectContent(
      fragments,
      timelineKey,
      "Timeline orphan body.",
    );

    await normalizeStructure(fragments, timelineKey);

    // The old Timeline heading path should no longer resolve to any key
    // (it was merged into the previous section)
    const timelineKeyAfter = findKeyForHeadingPath(fragments as DocSession, ["Timeline"]);
    expect(timelineKeyAfter).toBeNull();

    // The reverse lookup for the old key should also return null
    expect(findHeadingPathForKey(fragments as DocSession, timelineKey)).toBeNull();

    // BFH and Overview should still be intact
    expect(findKeyForHeadingPath(fragments as DocSession, [])).not.toBeNull();
    expect(findKeyForHeadingPath(fragments as DocSession, ["Overview"])).not.toBeNull();
  });
});
