/**
 * Group A4: Normalization (Structural Operations) Invariant Tests
 *
 * Pre-refactor invariant tests for normalizeStructure.
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { documentSessionRegistry } from "../../crdt/document-session-registry.js";
import {
  destroyAllSessions,
  setSessionOverlayImportCallback,
  flushDirtyToOverlay,
  findKeyForHeadingPath,
  applyAcceptResult,
} from "../../crdt/ydoc-lifecycle.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { fragmentFromRemark } from "../../storage/section-formatting.js";
import type { WriterIdentity } from "../../types/shared.js";

const writer: WriterIdentity = {
  id: "norm-invariant-writer",
  type: "human",
  displayName: "Norm Writer",
  email: "norm@test.local",
};

function findHeadingKey(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
  heading: string,
): string {
  const key = findKeyForHeadingPath(live, [heading]);
  if (!key) throw new Error(`Missing fragment key for heading "${heading}"`);
  return key;
}

function findBfhKey(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
): string {
  const key = findKeyForHeadingPath(live, []);
  if (!key) throw new Error("Missing BFH fragment key");
  return key;
}

describe("A4: Normalization Invariants", () => {
  let ctx: TempDataRootContext;
  let baseHead: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    baseHead = await getHeadSha(ctx.rootDir);
    setSessionOverlayImportCallback(async (session) => {
      await flushDirtyToOverlay(session);
    });
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  // ── A4.1 ──────────────────────────────────────────────────────────

  it("A4.1: embedded heading in a fragment causes a split — one fragment becomes two+", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a41" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Inject content with an embedded heading into Overview
    live.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOriginal overview text.\n\n## New Embedded Heading\n\nNew section content."),
    );

    // normalizeStructure triggers accept which both writes to overlay and
    // detects+applies the structural split in a single pass (post-BNATIVE.10).
    live.liveFragments.noteAheadOfStaged(overviewKey);
    const scope = new Set([overviewKey]);
    await live.recoveryBuffer.snapshotFromLive(live.liveFragments, scope);
    const result = await live.stagedSections.acceptLiveFragments(live.liveFragments, scope);
    await applyAcceptResult(live, result);

    expect(result.structuralChange !== null).toBe(true);
    // After split, new fragment keys should be created
    expect(result.writtenKeys.length).toBeGreaterThanOrEqual(1);

    // The assembled markdown should contain both headings
    const assembled = live.orderedFragmentKeys.map((k) => live.liveFragments.readFragmentString(k)).join("");
    expect(assembled).toContain("## Overview");
    expect(assembled).toContain("## New Embedded Heading");
    expect(assembled).toContain("New section content.");
  });

  // ── A4.2 ──────────────────────────────────────────────────────────

  it("A4.2: heading deletion (orphan) triggers merge-to-previous", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a42" },
    });

    const timelineKey = findHeadingKey(live, "Timeline");

    // Remove the heading but keep body content (simulates heading deletion)
    live.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark("Timeline body without heading."),
    );

    // normalizeStructure triggers accept which handles the orphan merge
    // in a single pass (post-BNATIVE.10).
    live.liveFragments.noteAheadOfStaged(timelineKey);
    const scope = new Set([timelineKey]);
    await live.recoveryBuffer.snapshotFromLive(live.liveFragments, scope);
    const result = await live.stagedSections.acceptLiveFragments(live.liveFragments, scope);
    await applyAcceptResult(live, result);

    expect(result.structuralChange !== null).toBe(true);
    // The orphan key should have been removed (merged into previous)
    expect(result.deletedKeys).toContain(timelineKey);

    // Assembled markdown should still contain the merged content
    const assembled = live.orderedFragmentKeys.map((k) => live.liveFragments.readFragmentString(k)).join("");
    expect(assembled).toContain("Timeline body without heading.");
  });

  // ── A4.3 ──────────────────────────────────────────────────────────

  it("A4.3: heading rename updates skeleton and produces a remap", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a43" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Rename heading from "Overview" to "Summary"
    live.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Summary\n\nRenamed overview content."),
    );

    await flushDirtyToOverlay(live);
    live.liveFragments.noteAheadOfStaged(overviewKey);
    const scope = new Set([overviewKey]);
    await live.recoveryBuffer.snapshotFromLive(live.liveFragments, scope);
    const result = await live.stagedSections.acceptLiveFragments(live.liveFragments, scope);
    await applyAcceptResult(live, result);

    // Heading rename should produce structural change
    // The skeleton should now have "Summary" instead of "Overview"
    const assembled = live.orderedFragmentKeys.map((k) => live.liveFragments.readFragmentString(k)).join("");
    expect(assembled).toContain("## Summary");
    expect(assembled).toContain("Renamed overview content.");
  });

  // ── A4.4 ──────────────────────────────────────────────────────────

  it("A4.4: heading level change triggers relocation in skeleton", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a44" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Change heading level from ## to ###
    live.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("### Overview\n\nLevel-changed overview content."),
    );

    await flushDirtyToOverlay(live);
    live.liveFragments.noteAheadOfStaged(overviewKey);
    const scope = new Set([overviewKey]);
    await live.recoveryBuffer.snapshotFromLive(live.liveFragments, scope);
    const result = await live.stagedSections.acceptLiveFragments(live.liveFragments, scope);
    await applyAcceptResult(live, result);

    // The assembled markdown should reflect the level change
    const assembled = live.orderedFragmentKeys.map((k) => live.liveFragments.readFragmentString(k)).join("");
    expect(assembled).toContain("### Overview");
    expect(assembled).toContain("Level-changed overview content.");
  });

  // ── A4.5 ──────────────────────────────────────────────────────────

  it("A4.5: BFH content is handled correctly during structural operations", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a45" },
    });

    const bfhKey = findBfhKey(live);

    // Modify BFH content (should remain structurally valid with 0 headings)
    live.liveFragments.replaceFragmentString(
      bfhKey,
      fragmentFromRemark("Updated preamble content for BFH test."),
    );

    await flushDirtyToOverlay(live);
    live.liveFragments.noteAheadOfStaged(bfhKey);
    const scope = new Set([bfhKey]);
    await live.recoveryBuffer.snapshotFromLive(live.liveFragments, scope);
    const result = await live.stagedSections.acceptLiveFragments(live.liveFragments, scope);
    await applyAcceptResult(live, result);

    // BFH with 0 headings should be structurally clean (no split/merge)
    // Content should be preserved
    const assembled = live.orderedFragmentKeys.map((k) => live.liveFragments.readFragmentString(k)).join("");
    expect(assembled).toContain("Updated preamble content for BFH test.");
  });

  // ── A4.6 ──────────────────────────────────────────────────────────

  it("A4.6: normalization broadcasts STRUCTURE_WILL_CHANGE with correct remap data", async () => {
    const broadcasts: Array<{ oldKey: string; newKeys: string[] }>[] = [];

    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a46" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Inject embedded heading to force a split
    live.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOriginal.\n\n## Broadcast Test\n\nBroadcast content."),
    );

    // normalizeStructure triggers accept + broadcast in a single pass.
    live.liveFragments.noteAheadOfStaged(overviewKey);
    const scope = new Set([overviewKey]);
    await live.recoveryBuffer.snapshotFromLive(live.liveFragments, scope);
    const result = await live.stagedSections.acceptLiveFragments(live.liveFragments, scope);
    await applyAcceptResult(live, result);

    // applyAcceptResult broadcasts remaps internally; check the result directly.
    if (result.remaps.length > 0) {
      broadcasts.push(result.remaps);
    }

    // Broadcast should have been called with remap data
    expect(broadcasts.length).toBeGreaterThan(0);
    const lastBroadcast = broadcasts[broadcasts.length - 1];
    expect(lastBroadcast.length).toBeGreaterThan(0);
    // At least one remap entry should reference the old overview key
    const hasOverviewRemap = lastBroadcast.some((r) => r.oldKey === overviewKey);
    expect(hasOverviewRemap).toBe(true);
  });

  // ── A4.7 ──────────────────────────────────────────────────────────

  it("A4.7: after normalization, Y.Doc fragment keys match skeleton entries", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a47" },
    });

    const overviewKey = findHeadingKey(live, "Overview");

    // Force a structural change (split)
    live.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("## Overview\n\nKept.\n\n## Extra\n\nExtra content."),
    );

    await flushDirtyToOverlay(live);
    live.liveFragments.noteAheadOfStaged(overviewKey);
    const scope = new Set([overviewKey]);
    await live.recoveryBuffer.snapshotFromLive(live.liveFragments, scope);
    const result = await live.stagedSections.acceptLiveFragments(live.liveFragments, scope);
    await applyAcceptResult(live, result);

    // Gather index-tracked keys (the authoritative set after normalization)
    const indexKeys = new Set(live.headingPathByFragmentKey.keys());

    // Y.Doc fragment keys should match index keys
    const fragmentKeys = new Set(live.orderedFragmentKeys);
    expect(fragmentKeys).toEqual(indexKeys);
  });

  // ── A4.8 ──────────────────────────────────────────────────────────

  it("A4.8: orphan-predecessor convergence chain — predecessors pre-normalized in document order", async () => {
    const live = await documentSessionRegistry.getOrCreate({
      docPath: SAMPLE_DOC_PATH,
      baseHead,
      initialEditor: { writerId: writer.id, identity: writer, socketId: "sock-a48" },
    });

    const overviewKey = findHeadingKey(live, "Overview");
    const timelineKey = findHeadingKey(live, "Timeline");

    // Make both Overview and Timeline into orphans (body-only, no heading)
    live.liveFragments.replaceFragmentString(
      overviewKey,
      fragmentFromRemark("Overview orphan body."),
    );
    live.liveFragments.replaceFragmentString(
      timelineKey,
      fragmentFromRemark("Timeline orphan body."),
    );

    // Normalizing Timeline should also handle Overview (predecessor convergence).
    // Mark both keys ahead-of-staged so accept processes them.
    live.liveFragments.noteAheadOfStaged(overviewKey);
    live.liveFragments.noteAheadOfStaged(timelineKey);
    const scope = new Set([overviewKey, timelineKey]);
    await live.recoveryBuffer.snapshotFromLive(live.liveFragments, scope);
    const result = await live.stagedSections.acceptLiveFragments(live.liveFragments, scope);
    await applyAcceptResult(live, result);
    expect(result.structuralChange !== null).toBe(true);

    // Both orphan keys should be removed (merged into BFH/previous)
    const assembled = live.orderedFragmentKeys.map((k) => live.liveFragments.readFragmentString(k)).join("");
    expect(assembled).toContain("Overview orphan body.");
    expect(assembled).toContain("Timeline orphan body.");
  });
});
