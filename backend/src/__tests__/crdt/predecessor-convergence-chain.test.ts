/**
 * D3: Predecessor Convergence Chain Tests
 *
 * Tests the predecessor convergence chain behavior of
 * `StagedSectionsStore.acceptLiveFragments`. When an orphan fragment (user
 * deleted its heading, leaving body-only content) is being accepted, any
 * orphan-only predecessors in document order are pre-normalized first.
 * This ensures heading deletions cascade correctly before the target
 * fragment itself is merged.
 *
 * Sample document: BFH (preamble), ## Overview, ## Timeline
 *
 * D3.1 -- Orphan with one orphan predecessor: both absorbed in single accept
 * D3.3 -- removedKeys includes predecessor fragment keys (not just target)
 * D3.4 -- contentByKey for merge-target contains accumulated body from all merged predecessors
 * D3.5 -- Mixed orphan/non-orphan predecessor chain: stops at first non-orphan
 * D3.6 -- Predecessor outside scope but orphan-only: still pre-normalized
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { buildDocumentFragmentsForTest, type TestDocSession } from "../helpers/build-document-fragments.js";
import { BEFORE_FIRST_HEADING_KEY, fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";

let ctx: TempDataRootContext;
let fragments: TestDocSession;

/** Collect all fragment keys from the heading-path index in document order. */
function collectKeys(frags: TestDocSession): {
  bfhKey: string;
  overviewKey: string;
  timelineKey: string;
  orderedKeys: string[];
} {
  let bfhKey: string | null = null;
  let overviewKey: string | null = null;
  let timelineKey: string | null = null;
  const orderedKeys: string[] = [];

  for (const key of frags.orderedFragmentKeys) {
    const hp = frags.headingPathByFragmentKey.get(key);
    if (!hp) continue;
    orderedKeys.push(key);
    const heading = hp[hp.length - 1] || "";
    if (hp.length === 0) bfhKey = key;
    if (heading === "Overview") overviewKey = key;
    if (heading === "Timeline") timelineKey = key;
  }

  if (!bfhKey) throw new Error("Missing BFH key");
  if (!overviewKey) throw new Error("Missing Overview key");
  if (!timelineKey) throw new Error("Missing Timeline key");

  return { bfhKey, overviewKey, timelineKey, orderedKeys };
}

describe("D3: Predecessor Convergence Chain", () => {
  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    fragments = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);
    // Clear ahead-of-staged from the initial load so tests start clean
    fragments.liveFragments.clearAheadOfStaged(fragments.liveFragments.getAheadOfStagedKeys());
  });

  afterEach(async () => {
    fragments.ydoc.destroy();
    await ctx.cleanup();
  });

  // ── D3.1 ──────────────────────────────────────────────────────────

  it("D3.1: orphan with one orphan predecessor -- both absorbed in single acceptLiveFragments call, predecessor processed first", async () => {
    const { bfhKey, overviewKey, timelineKey } = collectKeys(fragments);

    // Make Overview an orphan (body only, no heading)
    fragments.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("Overview orphan body."), "test");
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Make Timeline an orphan (body only, no heading)
    fragments.liveFragments.replaceFragmentString(timelineKey, fragmentFromRemark("Timeline orphan body."), "test");
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    // Accept only Timeline -- predecessor convergence should pull in Overview first
    const scope = new Set<string>([timelineKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(fragments.liveFragments, scope);

    // Both orphan keys should be removed (merged into BFH)
    expect(result.deletedKeys).toContain(overviewKey);
    expect(result.deletedKeys).toContain(timelineKey);

    // The structural change should be non-null since merges happened
    expect(result.structuralChange).not.toBeNull();
  });

  // ── D3.3 ──────────────────────────────────────────────────────────

  it("D3.3: after predecessor convergence, removedKeys includes predecessor fragment keys (not just target)", async () => {
    const { overviewKey, timelineKey } = collectKeys(fragments);

    // Make both Overview and Timeline orphans
    fragments.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("Overview orphan for D3.3."), "test");
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    fragments.liveFragments.replaceFragmentString(timelineKey, fragmentFromRemark("Timeline orphan for D3.3."), "test");
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    // Accept only Timeline
    const scope = new Set<string>([timelineKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(fragments.liveFragments, scope);

    expect(result.structuralChange).not.toBeNull();
    const removedKeys = result.structuralChange!.removedKeys;

    // removedKeys must include the predecessor (Overview) as well as the target (Timeline)
    expect(removedKeys.has(overviewKey)).toBe(true);
    expect(removedKeys.has(timelineKey)).toBe(true);
  });

  // ── D3.4 ──────────────────────────────────────────────────────────

  it("D3.4: after predecessor convergence, contentByKey for merge-target contains accumulated body from all merged predecessors", async () => {
    const { bfhKey, overviewKey, timelineKey } = collectKeys(fragments);

    // Make both Overview and Timeline orphans
    fragments.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("Overview accumulated body."), "test");
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    fragments.liveFragments.replaceFragmentString(timelineKey, fragmentFromRemark("Timeline accumulated body."), "test");
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    // Accept only Timeline
    const scope = new Set<string>([timelineKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(fragments.liveFragments, scope);

    expect(result.structuralChange).not.toBeNull();
    const contentByKey = result.structuralChange!.contentByKey;

    // The BFH key is the merge target -- it should contain body from both predecessors
    const bfhContent = contentByKey.get(bfhKey);
    expect(bfhContent).toBeDefined();
    expect(String(bfhContent)).toContain("Overview accumulated body.");
    expect(String(bfhContent)).toContain("Timeline accumulated body.");
  });

  // ── D3.5 ──────────────────────────────────────────────────────────

  it("D3.5: mixed orphan/non-orphan predecessor chain -- stops at first non-orphan", async () => {
    const { overviewKey, timelineKey } = collectKeys(fragments);

    // Keep Overview as a normal headed section (non-orphan)
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOverview body stays headed."),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Make Timeline an orphan
    fragments.liveFragments.replaceFragmentString(timelineKey, fragmentFromRemark("Timeline orphan for D3.5."), "test");
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    // Accept both in scope
    const scope = new Set<string>([overviewKey, timelineKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(fragments.liveFragments, scope);

    // Timeline should be removed (merged into Overview as its immediate predecessor)
    expect(result.deletedKeys).toContain(timelineKey);

    // Overview should NOT be removed -- it is a normal headed section (non-orphan)
    expect(result.deletedKeys).not.toContain(overviewKey);

    // The structural change's contentByKey for Overview should contain Timeline's orphan body
    expect(result.structuralChange).not.toBeNull();
    const contentByKey = result.structuralChange!.contentByKey;

    // Find the key that Overview was written/reloaded as (it may have been
    // rewritten under the same or a new key depending on rename behavior)
    let overviewContentFound = false;
    for (const [_key, content] of contentByKey) {
      if (String(content).includes("Timeline orphan for D3.5.")) {
        overviewContentFound = true;
        // The merge target (Overview) should retain its heading
        expect(String(content)).toContain("## Overview");
        break;
      }
    }
    expect(overviewContentFound).toBe(true);
  });

  // ── D3.6 ──────────────────────────────────────────────────────────

  it("D3.6: predecessor outside scope but orphan-only -- still pre-normalized by convergence", async () => {
    const { overviewKey, timelineKey } = collectKeys(fragments);

    // Make Overview an orphan
    fragments.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("Overview orphan outside scope."), "test");
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Make Timeline an orphan
    fragments.liveFragments.replaceFragmentString(timelineKey, fragmentFromRemark("Timeline orphan in scope."), "test");
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    // Accept ONLY Timeline -- Overview is NOT in scope, but convergence should still process it
    const scope = new Set<string>([timelineKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(fragments.liveFragments, scope);

    // Both should be removed despite Overview not being in the explicit scope
    expect(result.deletedKeys).toContain(overviewKey);
    expect(result.deletedKeys).toContain(timelineKey);

    // Structural change should reflect both removals
    expect(result.structuralChange).not.toBeNull();
    expect(result.structuralChange!.removedKeys.has(overviewKey)).toBe(true);
    expect(result.structuralChange!.removedKeys.has(timelineKey)).toBe(true);
  });
});
