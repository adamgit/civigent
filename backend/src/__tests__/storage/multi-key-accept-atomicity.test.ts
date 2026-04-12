/**
 * D7: Multi-key acceptance behavior of StagedSectionsStore.acceptLiveFragments
 *
 * Tests that multi-key accept calls process all keys correctly, that a
 * structural change from one key does not corrupt another key's content,
 * and that keys are processed in document order regardless of Set iteration
 * order.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { buildDocumentFragmentsForTest, type TestDocSession } from "../helpers/build-document-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";

describe("D7: Multi-key accept atomicity", () => {
  let ctx: TempDataRootContext;
  let fragments: TestDocSession;

  /** Collect fragment keys from the heading-path index in document order. */
  function collectKeys(): { bfhKey: string; overviewKey: string; timelineKey: string } {
    let bfhKey: string | null = null;
    let overviewKey: string | null = null;
    let timelineKey: string | null = null;

    for (const [key, hp] of fragments.headingPathByFragmentKey) {
      if (hp.length === 0) bfhKey = key;
      else if (hp[hp.length - 1] === "Overview") overviewKey = key;
      else if (hp[hp.length - 1] === "Timeline") timelineKey = key;
    }

    if (!bfhKey) throw new Error("BFH key not found");
    if (!overviewKey) throw new Error("Overview key not found");
    if (!timelineKey) throw new Error("Timeline key not found");

    return { bfhKey, overviewKey, timelineKey };
  }

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    fragments = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);
    // Clear ahead-of-staged so the baseline is clean.
    fragments.liveFragments.clearAheadOfStaged(fragments.liveFragments.getAheadOfStagedKeys());
  });

  afterEach(async () => {
    fragments.ydoc.destroy();
    await ctx.cleanup();
  });

  // ── D7.1 ──────────────────────────────────────────────────────────

  it("D7.1: 3-key accept where one causes structural change — all 3 processed, structural change from one does not corrupt the other two", async () => {
    const { bfhKey, overviewKey, timelineKey } = collectKeys();

    // Mutate BFH: body-only change (no structural impact).
    fragments.liveFragments.replaceFragmentString(
      bfhKey,
      fragmentFromRemark("Updated preamble for the strategy document."),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(bfhKey);

    // Mutate Overview: embed a new heading (split -> structural change).
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark([
        "## Overview",
        "",
        "Updated overview body.",
        "",
        "## Decisions",
        "",
        "Decisions body from embedded heading.",
      ].join("\n")),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Mutate Timeline: body-only change (no structural impact).
    fragments.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark([
        "## Timeline",
        "",
        "Q1: Planning. Q2: Execution. Q3: Review. Q4: Retrospective.",
      ].join("\n")),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    // Accept all 3 in one call.
    const scope = new Set([bfhKey, overviewKey, timelineKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(fragments.liveFragments, scope);

    // All 3 original keys must be accepted.
    expect(result.acceptedKeys.has(bfhKey)).toBe(true);
    expect(result.acceptedKeys.has(overviewKey)).toBe(true);
    expect(result.acceptedKeys.has(timelineKey)).toBe(true);

    // Structural change should be non-null (Overview split into Overview + Decisions).
    expect(result.structuralChange).not.toBeNull();

    // BFH and Timeline should be in writtenKeys (body-only changes)
    expect(result.writtenKeys).toContain(bfhKey);
    expect(result.writtenKeys).toContain(timelineKey);
    // Overview may have a new key after split — check it was at least written
    // (old key or new keys from the remap)
    expect(result.writtenKeys.length).toBeGreaterThanOrEqual(3);

    // Verify Timeline's body-only change was accepted and not corrupted
    // by the structural change from Overview.
    expect(result.deletedKeys).not.toContain(timelineKey);
    expect(result.deletedKeys).not.toContain(bfhKey);

    // The structural change should show the new Decisions section in its
    // ordered keys.
    if (result.structuralChange) {
      const orderedKeySet = new Set(result.structuralChange.orderedKeys);
      // BFH and Timeline must survive the structural mutation.
      expect(orderedKeySet.has(bfhKey)).toBe(true);
      expect(orderedKeySet.has(timelineKey)).toBe(true);
      // The split should produce more keys than the original 3
      expect(result.structuralChange.orderedKeys.length).toBeGreaterThanOrEqual(4);
    }
  });

  // ── D7.3 ──────────────────────────────────────────────────────────

  it("D7.3: acceptLiveFragments processes keys in document order (not arbitrary Set iteration order)", async () => {
    const { overviewKey, timelineKey } = collectKeys();

    // Mutate Overview with a body-only change.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark([
        "## Overview",
        "",
        "Overview body updated for D7.3 ordering test.",
      ].join("\n")),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Mutate Timeline: delete its heading (orphan-only). This triggers
    // the orphan-predecessor convergence chain inside acceptLiveFragments.
    // If processed in wrong order (Timeline before Overview), the
    // predecessor lookup for Timeline would reference Overview's pre-accept
    // state, which could cause incorrect merge behavior.
    fragments.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark("Timeline orphan body — heading deleted."),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    // Pass scope with Timeline FIRST (reverse document order) to verify
    // that the implementation reorders to document order internally.
    const scope = new Set([timelineKey, overviewKey]);
    const result = await fragments.stagedSections.acceptLiveFragments(fragments.liveFragments, scope);

    // Both keys must be accepted (no crash from wrong processing order).
    expect(result.acceptedKeys.has(overviewKey)).toBe(true);
    expect(result.acceptedKeys.has(timelineKey)).toBe(true);

    // Timeline was an orphan (heading deleted), so it should have been
    // removed and its body merged into Overview (its predecessor).
    expect(result.deletedKeys).toContain(timelineKey);

    // Structural change must be non-null because Timeline was removed.
    expect(result.structuralChange).not.toBeNull();

    if (result.structuralChange) {
      // Timeline key should be in the removed set.
      expect(result.structuralChange.removedKeys.has(timelineKey)).toBe(true);

      // Overview should still exist in the post-mutation ordered keys.
      expect(result.structuralChange.orderedKeys).toContain(overviewKey);

      // Timeline should NOT be in the post-mutation ordered keys
      // (it was absorbed).
      expect(result.structuralChange.orderedKeys).not.toContain(timelineKey);

      // The Overview's post-mutation content should contain the orphan
      // body that was merged from Timeline.
      const overviewContent = result.structuralChange.contentByKey.get(overviewKey);
      expect(overviewContent).toBeDefined();
      expect(String(overviewContent)).toContain("Timeline orphan body");
    }
  });
});
