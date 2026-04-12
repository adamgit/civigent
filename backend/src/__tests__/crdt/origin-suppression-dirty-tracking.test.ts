/**
 * Origin suppression and dirty key tracking tests for
 * LiveFragmentStringsStore and StagedSectionsStore.acceptLiveFragments.
 *
 * Covers:
 *   D4.1 -- applyStructuralChange writes with SERVER_INJECTION_ORIGIN do NOT
 *           mark keys as ahead-of-staged.
 *   D4.4 -- Writes with a non-server origin ARE marked ahead-of-staged,
 *           proving suppression is origin-specific (not a global flag).
 *   D5.1 -- After a successful acceptLiveFragments, accepted keys are cleared
 *           from aheadOfStagedKeys.
 *   D5.3 -- Partial-scope accept: keys NOT in scope remain in
 *           aheadOfStagedKeys after acceptance.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { buildDocumentFragmentsForTest, type TestDocSession, SERVER_INJECTION_ORIGIN } from "../helpers/build-document-fragments.js";
import { fragmentKeyFromSectionFile, BEFORE_FIRST_HEADING_KEY } from "../../crdt/ydoc-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import type { StructuralChange } from "../../crdt/live-fragment-strings-store.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function findKeyByHeading(
  fragments: TestDocSession,
  heading: string,
): string {
  for (const [key, hp] of fragments.headingPathByFragmentKey) {
    const h = hp[hp.length - 1] || "";
    if (h === heading) return key;
  }
  throw new Error(`Missing fragment key for heading "${heading}"`);
}

function findBfhKey(fragments: TestDocSession): string {
  for (const [key, hp] of fragments.headingPathByFragmentKey) {
    if (hp.length === 0) return key;
  }
  throw new Error("Missing BFH fragment key");
}

// ─── Test suite ──────────────────────────────────────────────────────

describe("Origin suppression and dirty key tracking", () => {
  let ctx: TempDataRootContext;
  let fragments: TestDocSession;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    fragments = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);
    // ALWAYS clear ahead-of-staged after build so tests start from a clean slate.
    fragments.liveFragments.clearAheadOfStaged(fragments.liveFragments.getAheadOfStagedKeys());
  });

  afterEach(async () => {
    fragments.ydoc.destroy();
    await ctx.cleanup();
  });

  // ── D4.1 ───────────────────────────────────────────────────────────
  // applyStructuralChange writes new fragment content with
  // SERVER_INJECTION_ORIGIN -- written keys NOT added to aheadOfStagedKeys.

  it("D4.1: applyStructuralChange with SERVER_INJECTION_ORIGIN does not mark keys ahead-of-staged", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");

    // Inject content with an embedded heading into Overview so that
    // acceptance triggers a structural split.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOriginal overview text.\n\n## Embedded\n\nEmbedded section content."),
      SERVER_INJECTION_ORIGIN,
    );

    // Mark overview as ahead-of-staged so acceptLiveFragments processes it.
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Accept the fragment -- this triggers the split and returns a structural change.
    const result = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      new Set([overviewKey]),
    );

    expect(result.structuralChange).not.toBeNull();

    // Clear ahead-of-staged completely BEFORE applying the structural change.
    fragments.liveFragments.clearAheadOfStaged(fragments.liveFragments.getAheadOfStagedKeys());
    expect(fragments.liveFragments.getAheadOfStagedKeys().size).toBe(0);

    // Apply the structural change -- all writes use SERVER_INJECTION_ORIGIN internally.
    fragments.liveFragments.applyStructuralChange(result.structuralChange!);

    // Verify: the structural change writes did NOT mark any keys as ahead-of-staged.
    expect(fragments.liveFragments.getAheadOfStagedKeys().size).toBe(0);
  });

  // ── D4.4 ───────────────────────────────────────────────────────────
  // Concurrent client update arriving DURING applyStructuralChange IS
  // marked ahead-of-staged (suppression is origin-specific, not global).

  it("D4.4: replaceFragmentString with non-server origin marks keys ahead-of-staged; server origin does not", () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");

    // Baseline: no keys ahead-of-staged.
    expect(fragments.liveFragments.getAheadOfStagedKeys().size).toBe(0);

    // Write with SERVER_INJECTION_ORIGIN -- must NOT be marked ahead-of-staged.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nServer-injected content."),
      SERVER_INJECTION_ORIGIN,
    );
    expect(fragments.liveFragments.getAheadOfStagedKeys().has(overviewKey)).toBe(false);
    expect(fragments.liveFragments.getAheadOfStagedKeys().size).toBe(0);

    // Write with a client origin -- MUST be marked ahead-of-staged.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nClient-edited content."),
      "client-origin",
    );
    expect(fragments.liveFragments.getAheadOfStagedKeys().has(overviewKey)).toBe(true);
  });

  // ── D5.1 ───────────────────────────────────────────────────────────
  // After a successful acceptLiveFragments, the accepted keys are cleared
  // from aheadOfStagedKeys.

  it("D5.1: accepted keys are cleared from aheadOfStagedKeys after successful accept", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");

    // Write with a client origin so it becomes ahead-of-staged.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nUpdated by client for D5.1."),
      "client-origin",
    );
    expect(fragments.liveFragments.getAheadOfStagedKeys().has(overviewKey)).toBe(true);

    // Accept -- the accepted key should be cleared from aheadOfStagedKeys.
    const result = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      new Set([overviewKey]),
    );

    expect(result.acceptedKeys.has(overviewKey)).toBe(true);
    expect(fragments.liveFragments.getAheadOfStagedKeys().has(overviewKey)).toBe(false);
  });

  // ── D5.3 ───────────────────────────────────────────────────────────
  // Partial-scope accept: keys NOT in scope remain in aheadOfStagedKeys.

  it("D5.3: partial-scope accept leaves out-of-scope keys in aheadOfStagedKeys", async () => {
    const overviewKey = findKeyByHeading(fragments, "Overview");
    const timelineKey = findKeyByHeading(fragments, "Timeline");

    // Write to both fragments with a client origin so both become ahead-of-staged.
    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nD5.3 overview change."),
      "client-origin",
    );
    fragments.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark("## Timeline\n\nD5.3 timeline change."),
      "client-origin",
    );

    expect(fragments.liveFragments.getAheadOfStagedKeys().has(overviewKey)).toBe(true);
    expect(fragments.liveFragments.getAheadOfStagedKeys().has(timelineKey)).toBe(true);

    // Accept with scope containing ONLY overviewKey.
    const result = await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      new Set([overviewKey]),
    );

    expect(result.acceptedKeys.has(overviewKey)).toBe(true);

    // overviewKey is no longer ahead-of-staged.
    expect(fragments.liveFragments.getAheadOfStagedKeys().has(overviewKey)).toBe(false);
    // timelineKey IS still ahead-of-staged (was not in scope).
    expect(fragments.liveFragments.getAheadOfStagedKeys().has(timelineKey)).toBe(true);
  });
});
