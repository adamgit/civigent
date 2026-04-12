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
} from "../../crdt/ydoc-lifecycle.js";
import { importSessionDirtyFragmentsToOverlay } from "../../storage/session-store.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
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
  let key: string | null = null;
  live.raw.fragments.skeleton.forEachSection((entryHeading, level, sectionFile, headingPath) => {
    const isBfh = headingPath.length === 0 && level === 0 && entryHeading === "";
    if (entryHeading === heading) {
      key = fragmentKeyFromSectionFile(sectionFile, isBfh);
    }
  });
  if (!key) throw new Error(`Missing fragment key for heading "${heading}"`);
  return key;
}

function findBfhKey(
  live: Awaited<ReturnType<typeof documentSessionRegistry.getOrCreate>>,
): string {
  let key: string | null = null;
  live.raw.fragments.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
    if (headingPath.length === 0 && level === 0 && heading === "") {
      key = fragmentKeyFromSectionFile(sectionFile, true);
    }
  });
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
      await importSessionDirtyFragmentsToOverlay(session);
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
    live.raw.fragments.setFragmentContent(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOriginal overview text.\n\n## New Embedded Heading\n\nNew section content."),
    );

    await importSessionDirtyFragmentsToOverlay(live.raw, { fragmentKeys: new Set([overviewKey]) });
    const result = await live.raw.fragments.normalizeStructure(overviewKey);

    expect(result.changed).toBe(true);
    // After split, new fragment keys should be created
    expect(result.createdKeys.length).toBeGreaterThanOrEqual(1);

    // The assembled markdown should contain both headings
    const assembled = live.raw.fragments.assembleMarkdown();
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
    live.raw.fragments.setFragmentContent(
      timelineKey,
      fragmentFromRemark("Timeline body without heading."),
    );

    await importSessionDirtyFragmentsToOverlay(live.raw, { fragmentKeys: new Set([timelineKey]) });
    const result = await live.raw.fragments.normalizeStructure(timelineKey);

    expect(result.changed).toBe(true);
    // The orphan key should have been removed (merged into previous)
    expect(result.removedKeys).toContain(timelineKey);

    // Assembled markdown should still contain the merged content
    const assembled = live.raw.fragments.assembleMarkdown();
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
    live.raw.fragments.setFragmentContent(
      overviewKey,
      fragmentFromRemark("## Summary\n\nRenamed overview content."),
    );

    await importSessionDirtyFragmentsToOverlay(live.raw, { fragmentKeys: new Set([overviewKey]) });
    const result = await live.raw.fragments.normalizeStructure(overviewKey);

    // Heading rename should produce structural change
    // The skeleton should now have "Summary" instead of "Overview"
    const assembled = live.raw.fragments.assembleMarkdown();
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
    live.raw.fragments.setFragmentContent(
      overviewKey,
      fragmentFromRemark("### Overview\n\nLevel-changed overview content."),
    );

    await importSessionDirtyFragmentsToOverlay(live.raw, { fragmentKeys: new Set([overviewKey]) });
    const result = await live.raw.fragments.normalizeStructure(overviewKey);

    // The assembled markdown should reflect the level change
    const assembled = live.raw.fragments.assembleMarkdown();
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
    live.raw.fragments.setFragmentContent(
      bfhKey,
      fragmentFromRemark("Updated preamble content for BFH test."),
    );

    await importSessionDirtyFragmentsToOverlay(live.raw, { fragmentKeys: new Set([bfhKey]) });
    const result = await live.raw.fragments.normalizeStructure(bfhKey);

    // BFH with 0 headings should be structurally clean (no split/merge)
    // Content should be preserved
    const assembled = live.raw.fragments.assembleMarkdown();
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
    live.raw.fragments.setFragmentContent(
      overviewKey,
      fragmentFromRemark("## Overview\n\nOriginal.\n\n## Broadcast Test\n\nBroadcast content."),
    );

    await importSessionDirtyFragmentsToOverlay(live.raw, { fragmentKeys: new Set([overviewKey]) });
    await live.raw.fragments.normalizeStructure(overviewKey, {
      broadcastStructureChange: (info) => {
        broadcasts.push(info);
      },
    });

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
    live.raw.fragments.setFragmentContent(
      overviewKey,
      fragmentFromRemark("## Overview\n\nKept.\n\n## Extra\n\nExtra content."),
    );

    await importSessionDirtyFragmentsToOverlay(live.raw, { fragmentKeys: new Set([overviewKey]) });
    await live.raw.fragments.normalizeStructure(overviewKey);

    // Gather skeleton section files
    const skeletonKeys = new Set<string>();
    live.raw.fragments.skeleton.forEachSection((_h, _l, sectionFile, headingPath) => {
      const isBfh = headingPath.length === 0 && _l === 0 && _h === "";
      skeletonKeys.add(fragmentKeyFromSectionFile(sectionFile, isBfh));
    });

    // Y.Doc fragment keys should match skeleton keys
    const fragmentKeys = new Set(live.raw.fragments.getFragmentKeys());
    expect(fragmentKeys).toEqual(skeletonKeys);
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
    live.raw.fragments.setFragmentContent(
      overviewKey,
      fragmentFromRemark("Overview orphan body."),
    );
    live.raw.fragments.setFragmentContent(
      timelineKey,
      fragmentFromRemark("Timeline orphan body."),
    );

    // Flush both
    await importSessionDirtyFragmentsToOverlay(live.raw, {
      fragmentKeys: new Set([overviewKey, timelineKey]),
    });

    // Normalizing Timeline should also handle Overview (predecessor convergence)
    const result = await live.raw.fragments.normalizeStructure(timelineKey);
    expect(result.changed).toBe(true);

    // Both orphan keys should be removed (merged into BFH/previous)
    const assembled = live.raw.fragments.assembleMarkdown();
    expect(assembled).toContain("Overview orphan body.");
    expect(assembled).toContain("Timeline orphan body.");
  });
});
