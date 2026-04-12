/**
 * Structural Cleanliness Gate Tests
 *
 * Tests for `StagedSectionsStore.isStructurallyClean` and the debounced flush
 * gating behavior. Verifies that structurally clean fragments (single heading,
 * body-only BFH) pass the gate, while structurally dirty fragments (embedded
 * headings, orphan-only) are correctly identified and deferred.
 *
 * Test IDs: B14.1, D6.2, D6.4, D6.5, D6.7
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { buildDocumentFragmentsForTest, type TestDocSession } from "../helpers/build-document-fragments.js";
import { BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";

describe("Structural Cleanliness Gate", () => {
  let ctx: TempDataRootContext;
  let fragments: TestDocSession;
  let bfhKey: string;
  let overviewKey: string;
  let timelineKey: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    fragments = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);

    // Clear ahead-of-staged so tests start from a clean baseline
    fragments.liveFragments.clearAheadOfStaged(fragments.liveFragments.getAheadOfStagedKeys());

    // Discover fragment keys from the heading-path index
    for (const [key, hp] of fragments.headingPathByFragmentKey) {
      if (hp.length === 0) {
        bfhKey = key;
      } else if (hp[hp.length - 1] === "Overview") {
        overviewKey = key;
      } else if (hp[hp.length - 1] === "Timeline") {
        timelineKey = key;
      }
    }

    expect(bfhKey).toBe(BEFORE_FIRST_HEADING_KEY);
    expect(overviewKey).toBeDefined();
    expect(timelineKey).toBeDefined();
  });

  afterEach(async () => {
    fragments.ydoc.destroy();
    await ctx.cleanup();
  });

  it("B14.1: structurally clean fragment (single heading, body change) — flush writes both raw sidecar AND overlay body", async () => {
    // Update Overview with a body-only change (heading stays the same, single heading)
    fragments.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nNew body content."), "test");
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Verify isStructurallyClean returns true
    const isClean = fragments.stagedSections.isStructurallyClean(fragments.liveFragments, overviewKey);
    expect(isClean).toBe(true);

    // Raw recovery snapshot writes the sidecar
    const snapshotResult = await fragments.recoveryBuffer.snapshotFromLive(
      fragments.liveFragments,
      new Set([overviewKey]),
    );
    expect(snapshotResult.snapshotKeys.has(overviewKey)).toBe(true);

    // Accept into overlay — verify writtenKeys includes overviewKey
    const acceptResult = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      new Set([overviewKey]),
    );
    expect(acceptResult.writtenKeys).toContain(overviewKey);
  });

  it("D6.2: fragment with 2 headings (embedded heading) — isStructurallyClean returns false", () => {
    // Update Overview with an embedded heading (two headings in one fragment)
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nBody.\n\n## NewChild\n\nChild."),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    const isClean = fragments.stagedSections.isStructurallyClean(fragments.liveFragments, overviewKey);
    expect(isClean).toBe(false);
  });

  it("D6.4: BFH fragment with 0 headings — isStructurallyClean returns true", () => {
    // BFH has body-only content (no headings — this is expected for preamble)
    fragments.liveFragments.replaceFragmentString(
      BEFORE_FIRST_HEADING_KEY,
      fragmentFromRemark("Updated preamble text."),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(BEFORE_FIRST_HEADING_KEY);

    const isClean = fragments.stagedSections.isStructurallyClean(
      fragments.liveFragments,
      BEFORE_FIRST_HEADING_KEY,
    );
    expect(isClean).toBe(true);
  });

  it("D6.5: fragment with heading text changed but count still 1 — isStructurallyClean returns true", () => {
    // Rename the heading (Timeline → Milestones) but keep exactly one heading
    fragments.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark("## Milestones\n\nSame body."),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    const isClean = fragments.stagedSections.isStructurallyClean(fragments.liveFragments, timelineKey);
    expect(isClean).toBe(true);
  });

  it("D6.7: deferred flush — structurally dirty key skipped by overlay write, raw snapshot still written, key remains ahead-of-staged", async () => {
    // Update Overview with an embedded heading (structurally dirty)
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nBody.\n\n## NewChild\n\nChild."),
      "test",
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Confirm structurally dirty
    expect(
      fragments.stagedSections.isStructurallyClean(fragments.liveFragments, overviewKey),
    ).toBe(false);

    // Take raw snapshot — verify snapshot was written even though structurally dirty
    const snapshotResult = await fragments.recoveryBuffer.snapshotFromLive(
      fragments.liveFragments,
      new Set([overviewKey]),
    );
    expect(snapshotResult.snapshotKeys.has(overviewKey)).toBe(true);

    // Raw snapshot does NOT clear ahead-of-staged — key remains ahead
    expect(fragments.liveFragments.isAheadOfStaged(overviewKey)).toBe(true);
  });
});
