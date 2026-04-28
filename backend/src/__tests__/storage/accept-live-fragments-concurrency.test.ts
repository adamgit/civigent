/**
 * Concurrency audit failing test for `StagedSectionsStore.acceptLiveFragments`.
 *
 * Side A (the publish-collisions refactor at adbb331) removed caller-side
 * serialization (the `awaitPendingSessionImport` gates that auto-commit and
 * routes/index.ts used to call) but did NOT add a store-internal queue or
 * mutex. Production callers reach `acceptLiveFragments` from several
 * independent paths that are not mutually serialized:
 *
 *   - `runSessionQuiescenceIdleTick` (setTimeout-driven idle pass)
 *   - `publishUnpublishedSections` → `settleFragmentKeysUntilStable`
 *   - Pre-commit settle in restore/overwrite HTTP routes
 *   - Focus-change normalization (`normalizeFragment`)
 *
 * `LiveFragmentStringsStore.settleFragment` gates only PER-FRAGMENT-KEY via
 * `recoveryBuffer.tryBeginSettleWindow(fragmentKey)` — different keys
 * proceed in parallel and both invoke `acceptLiveFragments` on the same
 * `StagedSectionsStore` instance simultaneously.
 *
 * This test demonstrates the absence of internal serialization by invoking
 * `acceptLiveFragments` twice in parallel on the same store instance with
 * disjoint scopes. The wrapped method records the maximum number of
 * concurrent in-flight invocations; any value greater than 1 is the bug.
 *
 * The test is expected to FAIL on this commit. Per the checklist instruction,
 * we capture the bug — we do NOT fix it here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { buildDocumentFragmentsForTest, type TestDocSession } from "../helpers/build-document-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";

function findHeadingKey(fragments: TestDocSession, heading: string): string {
  for (const [key, hp] of fragments.headingPathByFragmentKey) {
    if (hp.length > 0 && hp[hp.length - 1] === heading) return key;
  }
  throw new Error(`Missing fragment key for heading "${heading}"`);
}

describe("acceptLiveFragments concurrency audit", () => {
  let ctx: TempDataRootContext;
  let fragments: TestDocSession;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    fragments = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);
    fragments.liveFragments.clearAheadOfStaged(fragments.liveFragments.getAheadOfStagedKeys());
  });

  afterEach(async () => {
    fragments.ydoc.destroy();
    await ctx.cleanup();
  });

  it("two concurrent acceptLiveFragments calls on the same store must not interleave", async () => {
    const overviewKey = findHeadingKey(fragments, "Overview");
    const timelineKey = findHeadingKey(fragments, "Timeline");

    fragments.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOverview body — concurrent path A.\n"),
      "writer-A",
    );
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    fragments.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark("## Timeline\n\nTimeline body — concurrent path B.\n"),
      "writer-B",
    );
    fragments.liveFragments.noteAheadOfStaged(timelineKey);

    let inFlight = 0;
    let maxInFlight = 0;
    const original = fragments.stagedSections.acceptLiveFragments.bind(fragments.stagedSections);
    fragments.stagedSections.acceptLiveFragments = async (liveStore, scope) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Yield once so the runtime has a chance to start the second invocation
      // before the first finishes its disk I/O. Without this, a pure-CPU
      // implementation could appear sequential by accident; the yield exposes
      // the real lack of internal serialization.
      await Promise.resolve();
      try {
        return await original(liveStore, scope);
      } finally {
        inFlight--;
      }
    };

    await Promise.all([
      fragments.stagedSections.acceptLiveFragments(fragments.liveFragments, new Set([overviewKey])),
      fragments.stagedSections.acceptLiveFragments(fragments.liveFragments, new Set([timelineKey])),
    ]);

    expect(maxInFlight).toBe(1);
  });
});
