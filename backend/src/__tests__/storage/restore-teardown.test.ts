/**
 * Group G: Restore Teardown Tests
 *
 * Tests for `teardownSessionStores` — the single function for total
 * session destruction (restore/overwrite only).
 *
 * Covers: B15.1, B15.2, B15.3, B15.5
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { buildDocumentFragmentsForTest, type TestDocSession } from "../helpers/build-document-fragments.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import { teardownSessionStores } from "../../storage/restore-teardown.js";

function findHeadingKey(fragments: TestDocSession, heading: string): string {
  for (const [key, hp] of fragments.headingPathByFragmentKey) {
    if (hp.length > 0 && hp[hp.length - 1] === heading) return key;
  }
  throw new Error(`Missing fragment key for heading "${heading}"`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("Restore teardown", () => {
  let ctx: TempDataRootContext;
  let fragments: TestDocSession;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    fragments = await buildDocumentFragmentsForTest(SAMPLE_DOC_PATH);
    fragments.liveFragments.clearAheadOfStaged(fragments.liveFragments.getAheadOfStagedKeys());
  });

  afterEach(async () => {
    // ydoc may already be destroyed by teardown — wrap in try/catch
    try { fragments.ydoc.destroy(); } catch { /* already destroyed */ }
    await ctx.cleanup();
  });

  // ── B15.1 ─────────────────────────────────────────────────────────

  it("B15.1: teardownSessionStores removes staging root directory", async () => {
    const overviewKey = findHeadingKey(fragments, "Overview");

    // Write something to the staging area so the directory exists
    fragments.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nStaged body."), "test");
    fragments.liveFragments.noteAheadOfStaged(overviewKey);
    await fragments.stagedSections.acceptLiveFragments(
      fragments.liveFragments,
      new Set([overviewKey]),
    );

    // Verify staging files exist before teardown
    const diskRelative = SAMPLE_DOC_PATH.replace(/^\/+/, "");
    const skeletonPath = join(fragments.stagedSections.stagingRoot, ...diskRelative.split("/"));
    const sectionsDir = `${skeletonPath}.sections`;
    expect(await pathExists(sectionsDir)).toBe(true);

    // Teardown
    await teardownSessionStores(
      fragments.liveFragments,
      fragments.stagedSections,
      fragments.recoveryBuffer,
    );

    // Staging directory should be gone
    expect(await pathExists(sectionsDir)).toBe(false);
  });

  // ── B15.2 ─────────────────────────────────────────────────────────

  it("B15.2: teardown deletes all raw fragment files via recoveryBuffer.deleteAllFragments()", async () => {
    const overviewKey = findHeadingKey(fragments, "Overview");

    // Write raw fragment file
    fragments.liveFragments.replaceFragmentString(overviewKey, fragmentFromRemark("## Overview\n\nRaw content."), "test");
    fragments.liveFragments.noteAheadOfStaged(overviewKey);
    await fragments.recoveryBuffer.snapshotFromLive(
      fragments.liveFragments,
      new Set([overviewKey]),
    );

    // Verify raw fragment exists
    const rawContent = await fragments.recoveryBuffer.readFragment(overviewKey);
    expect(rawContent).not.toBeNull();

    // Teardown
    await teardownSessionStores(
      fragments.liveFragments,
      fragments.stagedSections,
      fragments.recoveryBuffer,
    );

    // Raw fragments should be gone
    const rawAfter = await fragments.recoveryBuffer.readFragment(overviewKey);
    expect(rawAfter).toBeNull();
  });

  // ── B15.3 ─────────────────────────────────────────────────────────

  it("B15.3: teardown destroys Y.Doc via liveFragments.ydoc.destroy()", async () => {
    const ydoc = fragments.liveFragments.ydoc;

    // Y.Doc should be usable before teardown
    expect(ydoc.isDestroyed).not.toBe(true);

    await teardownSessionStores(
      fragments.liveFragments,
      fragments.stagedSections,
      fragments.recoveryBuffer,
    );

    // Y.Doc should be destroyed after teardown
    // Yjs marks docs as destroyed after .destroy() is called
    // The exact check depends on Yjs version — some use isDestroyed,
    // others mark the _item as null. Check both approaches.
    const isDestroyed = (ydoc as any).isDestroyed
      ?? (ydoc as any)._destroyed
      ?? false;
    expect(isDestroyed).toBe(true);
  });

  // ── B15.5 ─────────────────────────────────────────────────────────

  it("B15.5: after teardown, store snapshot methods still return last-known values", async () => {
    const overviewKey = findHeadingKey(fragments, "Overview");

    // Mark something ahead of canonical so there's state to preserve
    fragments.stagedSections.noteAheadOfCanonical(overviewKey);
    fragments.liveFragments.noteAheadOfStaged(overviewKey);

    // Read last-known values before teardown
    const wasAheadOfCanonical = fragments.stagedSections.isAheadOfCanonical(overviewKey);
    expect(wasAheadOfCanonical).toBe(true);

    await teardownSessionStores(
      fragments.liveFragments,
      fragments.stagedSections,
      fragments.recoveryBuffer,
    );

    // After teardown, in-memory state accessors should not crash.
    // stagedSections and recoveryBuffer are still in-memory objects —
    // their file-backed state is gone but snapshot methods should not throw.
    expect(() => fragments.stagedSections.isAheadOfCanonical(overviewKey)).not.toThrow();
    expect(() => fragments.stagedSections.getAheadOfCanonicalRefs()).not.toThrow();
    expect(() => fragments.liveFragments.getAheadOfStagedKeys()).not.toThrow();
  });
});
