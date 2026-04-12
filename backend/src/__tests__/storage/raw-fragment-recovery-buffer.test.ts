/**
 * RawFragmentRecoveryBuffer Unit Tests
 *
 * Tests for the crash-recovery sidecar's core read/write/snapshot behavior.
 * Verifies null-return semantics for missing keys, snapshot-from-live
 * content round-tripping, and correct intersection logic between scope
 * and ahead-of-staged keys.
 *
 * Test IDs: B6.4, B7.1, B7.2
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { buildDocumentFragmentsForTest, type TestDocSession } from "../helpers/build-document-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";

describe("RawFragmentRecoveryBuffer", () => {
  let ctx: TempDataRootContext;
  let fragments: TestDocSession;
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
      if (hp.length > 0 && hp[hp.length - 1] === "Overview") {
        overviewKey = key;
      } else if (hp.length > 0 && hp[hp.length - 1] === "Timeline") {
        timelineKey = key;
      }
    }

    expect(overviewKey).toBeDefined();
    expect(timelineKey).toBeDefined();
  });

  afterEach(async () => {
    fragments.ydoc.destroy();
    await ctx.cleanup();
  });

  it("B6.4: readFragment returns null (not throws) for a key that was never written", async () => {
    const result = await fragments.recoveryBuffer.readFragment("section::nonexistent");
    expect(result).toBeNull();
  });

  it("B7.1: snapshotFromLive reads ahead-of-staged keys from live store and writes raw files", async () => {
    // Mutate overview content and mark ahead-of-staged
    fragments.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nSnapshot test body."), "test");
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Read the live content before snapshot so we can compare
    const liveContent = fragments.liveFragments.readFragmentString(overviewKey);

    // Take snapshot
    const snapshotResult = await fragments.recoveryBuffer.snapshotFromLive(
      fragments.liveFragments,
      new Set([overviewKey]),
    );

    // Verify snapshotKeys contains overviewKey
    expect(snapshotResult.snapshotKeys.has(overviewKey)).toBe(true);

    // Verify readFragment returns non-null content matching what was in Y.Doc
    const recovered = await fragments.recoveryBuffer.readFragment(overviewKey);
    expect(recovered).not.toBeNull();
    expect(recovered).toBe(liveContent as string);
  });

  it("B7.2: snapshot only writes files for keys in both scope AND ahead-of-staged (correct intersection)", async () => {
    // Mark ONLY overviewKey as ahead-of-staged (mutate + noteAheadOfStaged)
    fragments.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nModified overview."), "test");
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // timelineKey is NOT marked ahead-of-staged

    // Call snapshot with scope containing BOTH keys
    const snapshotResult = await fragments.recoveryBuffer.snapshotFromLive(
      fragments.liveFragments,
      new Set([overviewKey, timelineKey]),
    );

    // Verify snapshotKeys contains ONLY overviewKey (the intersection)
    expect(snapshotResult.snapshotKeys.has(overviewKey)).toBe(true);
    expect(snapshotResult.snapshotKeys.has(timelineKey)).toBe(false);
    expect(snapshotResult.snapshotKeys.size).toBe(1);

    // Verify timelineKey was not written because it was not ahead-of-staged
    const timelineContent = await fragments.recoveryBuffer.readFragment(timelineKey);
    expect(timelineContent).toBeNull();
  });
});
