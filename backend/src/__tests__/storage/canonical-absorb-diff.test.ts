/**
 * Group G: Canonical Absorb Diff Tests
 *
 * Tests that `absorbChangedSections` returns correct `AbsorbResult`
 * with `commitSha` and `changedSections` diff.
 *
 * Covers: B11.1, B11.2
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { getHeadSha } from "../../storage/git-repo.js";

const AUTHOR = { name: "Absorb Diff Test", email: "absorb-diff@test.local" };

function toDiskRelative(docPath: string): string {
  return docPath.replace(/^\/+/, "");
}

async function copyDirectoryRecursive(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

describe("Canonical absorb diff", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function createStagingRoot(
    docPath: string,
    sectionOverrides: Record<string, string>,
  ): Promise<string> {
    const diskRelative = toDiskRelative(docPath);
    const stagingRoot = join(ctx.rootDir, "test-staging");
    const stagingSkeletonPath = join(stagingRoot, diskRelative);
    const stagingSectionsDir = `${stagingSkeletonPath}.sections`;

    const canonicalSkeleton = join(ctx.contentDir, diskRelative);
    await mkdir(dirname(stagingSkeletonPath), { recursive: true });
    await copyFile(canonicalSkeleton, stagingSkeletonPath);

    const canonicalSectionsDir = `${canonicalSkeleton}.sections`;
    await copyDirectoryRecursive(canonicalSectionsDir, stagingSectionsDir);
    for (const [file, body] of Object.entries(sectionOverrides)) {
      await writeFile(join(stagingSectionsDir, file), body + "\n", "utf8");
    }

    return stagingRoot;
  }

  // ── B11.1 ─────────────────────────────────────────────────────────

  it("B11.1: absorbChangedSections returns AbsorbResult with commitSha and changedSections", async () => {
    const stagingRoot = await createStagingRoot(SAMPLE_DOC_PATH, {
      "overview.md": "Brand new overview content for B11.1",
    });

    const store = new CanonicalStore(ctx.contentDir, ctx.rootDir);
    const result = await store.absorbChangedSections(
      stagingRoot,
      "test: absorb B11.1",
      AUTHOR,
      { docPaths: [SAMPLE_DOC_PATH] },
    );

    // commitSha should be a valid git SHA
    expect(result.commitSha).toBeTruthy();
    expect(typeof result.commitSha).toBe("string");

    // changedSections should be an array with at least the overview section
    expect(Array.isArray(result.changedSections)).toBe(true);
    expect(result.changedSections.length).toBeGreaterThanOrEqual(1);

    // Each entry should have docPath and headingPath
    for (const entry of result.changedSections) {
      // docPath may or may not have a leading slash depending on absorb normalization
      expect(entry.docPath).toBeTruthy();
      expect(Array.isArray(entry.headingPath)).toBe(true);
    }

    // The overview section should be in changedSections
    const overviewChanged = result.changedSections.find(
      (s) => s.headingPath.length === 1 && s.headingPath[0] === "Overview",
    );
    expect(overviewChanged).toBeDefined();
  });

  // ── B11.2 ─────────────────────────────────────────────────────────

  it("B11.2: changedSections excludes sections with body identical to canonical", async () => {
    // Stage with overview UNCHANGED (same as canonical) and timeline CHANGED
    const stagingRoot = await createStagingRoot(SAMPLE_DOC_PATH, {
      // overview.md is copied from canonical (unchanged)
      "timeline.md": "Completely rewritten timeline content for B11.2",
    });

    const store = new CanonicalStore(ctx.contentDir, ctx.rootDir);
    const result = await store.absorbChangedSections(
      stagingRoot,
      "test: absorb B11.2",
      AUTHOR,
      { docPaths: [SAMPLE_DOC_PATH] },
    );

    // Only timeline should be in changedSections, not overview
    const timelineChanged = result.changedSections.find(
      (s) => s.headingPath.length === 1 && s.headingPath[0] === "Timeline",
    );
    expect(timelineChanged).toBeDefined();

    // Overview should NOT be in changedSections (body identical to canonical)
    const overviewChanged = result.changedSections.find(
      (s) => s.headingPath.length === 1 && s.headingPath[0] === "Overview",
    );
    expect(overviewChanged).toBeUndefined();
  });
});
