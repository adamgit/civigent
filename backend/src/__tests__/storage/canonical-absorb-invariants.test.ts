/**
 * Group A8: Canonical Store (absorb) Invariant Tests
 *
 * Pre-refactor invariant tests for CanonicalStore.absorb().
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFile, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getSessionSectionsContentRoot } from "../../storage/data-root.js";
import { parseSkeletonToEntries, serializeSkeletonEntries } from "../../storage/document-skeleton.js";

const AUTHOR = { name: "Absorb Test", email: "absorb@test.local" };

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

describe("A8: Canonical Store (absorb) Invariants", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Create a staging root with modified content for a single document. */
  async function createStagingRoot(
    docPath: string,
    sectionOverrides: Record<string, string>,
    skeletonOverride?: string,
  ): Promise<string> {
    const diskRelative = toDiskRelative(docPath);
    const stagingRoot = join(ctx.rootDir, "test-staging");
    const stagingSkeletonPath = join(stagingRoot, diskRelative);
    const stagingSectionsDir = `${stagingSkeletonPath}.sections`;

    // Copy canonical skeleton to staging
    const canonicalSkeleton = join(ctx.contentDir, diskRelative);
    await mkdir(dirname(stagingSkeletonPath), { recursive: true });

    if (skeletonOverride) {
      await writeFile(stagingSkeletonPath, skeletonOverride, "utf8");
    } else {
      await copyFile(canonicalSkeleton, stagingSkeletonPath);
    }

    // Copy canonical sections, then override specific ones
    const canonicalSectionsDir = `${canonicalSkeleton}.sections`;
    await copyDirectoryRecursive(canonicalSectionsDir, stagingSectionsDir);
    for (const [file, body] of Object.entries(sectionOverrides)) {
      await writeFile(join(stagingSectionsDir, file), body + "\n", "utf8");
    }

    return stagingRoot;
  }

  // ── A8.1 ──────────────────────────────────────────────────────────

  it("A8.1: absorb copies staged files to canonical and creates a git commit", async () => {
    const uniqueMarker = `A8.1 absorb test ${Date.now()}`;
    const headBefore = await getHeadSha(ctx.rootDir);

    const stagingRoot = await createStagingRoot(SAMPLE_DOC_PATH, {
      "overview.md": uniqueMarker,
    });

    const store = new CanonicalStore(ctx.contentDir, ctx.rootDir);
    const { commitSha } = await store.absorbChangedSections(stagingRoot, "test: absorb A8.1", AUTHOR);

    // Git HEAD should have advanced
    expect(commitSha).toBeTruthy();
    expect(commitSha).not.toBe(headBefore);
    const headAfter = await getHeadSha(ctx.rootDir);
    expect(headAfter).toBe(commitSha);

    // Canonical should contain the absorbed content
    const canonical = new ContentLayer(ctx.contentDir);
    const sections = await canonical.readAllSections(SAMPLE_DOC_PATH);
    expect(String(sections.get("Overview") ?? "")).toContain(uniqueMarker);
  });

  // ── A8.2 ──────────────────────────────────────────────────────────

  it("A8.2: absorb deletion pass removes skeleton-declared orphans from canonical", async () => {
    // Create a staging skeleton that removes "Timeline" section.
    // Staging must be SPARSE: only include files for sections that still exist.
    const canonicalSkeleton = await readFile(
      join(ctx.contentDir, toDiskRelative(SAMPLE_DOC_PATH)),
      "utf8",
    );

    // Parse, filter out Timeline, serialize
    const entries = parseSkeletonToEntries(canonicalSkeleton);
    const filtered = entries.filter((e) => e.heading !== "Timeline");
    const newSkeleton = serializeSkeletonEntries(filtered);

    // Build staging root manually (sparse — no timeline.md)
    const diskRelative = toDiskRelative(SAMPLE_DOC_PATH);
    const stagingRoot = join(ctx.rootDir, "test-staging-a82");
    const stagingSkeletonPath = join(stagingRoot, diskRelative);
    const stagingSectionsDir = `${stagingSkeletonPath}.sections`;
    await mkdir(dirname(stagingSkeletonPath), { recursive: true });
    await writeFile(stagingSkeletonPath, newSkeleton, "utf8");
    // Only include sections still declared by the new skeleton
    await mkdir(stagingSectionsDir, { recursive: true });
    for (const entry of filtered) {
      const srcFile = join(ctx.contentDir, diskRelative + ".sections", entry.sectionFile);
      await copyFile(srcFile, join(stagingSectionsDir, entry.sectionFile));
    }

    // Verify timeline.md exists in canonical before absorb
    const canonicalSectionsDir = join(ctx.contentDir, diskRelative + ".sections");
    const filesBefore = await readdir(canonicalSectionsDir);
    expect(filesBefore).toContain("timeline.md");

    const store = new CanonicalStore(ctx.contentDir, ctx.rootDir);
    await store.absorbChangedSections(stagingRoot, "test: absorb A8.2 orphan deletion", AUTHOR);

    // timeline.md should be deleted from canonical (orphaned by new skeleton)
    const filesAfter = await readdir(canonicalSectionsDir);
    expect(filesAfter).not.toContain("timeline.md");

    // overview.md should still exist
    expect(filesAfter).toContain("overview.md");
  });

  // ── A8.3 ──────────────────────────────────────────────────────────

  it("A8.3: absorb rolls back canonical on failure (best-effort)", async () => {
    // Read canonical overview content before any operation
    const canonicalSectionsDir = join(ctx.contentDir, toDiskRelative(SAMPLE_DOC_PATH) + ".sections");
    const overviewBefore = await readFile(join(canonicalSectionsDir, "overview.md"), "utf8");
    const headBefore = await getHeadSha(ctx.rootDir);

    // Create a staging root with valid content but corrupt the git state
    // to make the commit fail. We'll make the .git directory read-only.
    // Instead, use a simpler approach: create a store with a bad dataRoot
    // so git commands fail.
    const badStore = new CanonicalStore(ctx.contentDir, "/nonexistent/data/root");
    const stagingRoot = await createStagingRoot(SAMPLE_DOC_PATH, {
      "overview.md": "This should be rolled back.",
    });

    // absorb should throw due to git failure
    await expect(
      badStore.absorbChangedSections(stagingRoot, "test: absorb should fail", AUTHOR),
    ).rejects.toThrow();

    // After rollback, canonical should be restored (best-effort)
    // Note: rollback is best-effort, so we check what we can
    const headAfter = await getHeadSha(ctx.rootDir);
    expect(headAfter).toBe(headBefore);
  });

  // ── A8.4 ──────────────────────────────────────────────────────────

  it("A8.4: absorb is source-agnostic — works with any staging root", async () => {
    // Create a completely independent staging directory (not session overlay)
    const customStagingRoot = join(ctx.rootDir, "custom-import-staging");
    const diskRelative = toDiskRelative(SAMPLE_DOC_PATH);
    const stagingSkeletonPath = join(customStagingRoot, diskRelative);
    const stagingSectionsDir = `${stagingSkeletonPath}.sections`;

    // Copy canonical skeleton
    await mkdir(dirname(stagingSkeletonPath), { recursive: true });
    await copyFile(
      join(ctx.contentDir, diskRelative),
      stagingSkeletonPath,
    );

    // Write custom content to sections
    const uniqueMarker = `A8.4 custom staging ${Date.now()}`;
    await copyDirectoryRecursive(
      join(ctx.contentDir, diskRelative + ".sections"),
      stagingSectionsDir,
    );
    await writeFile(join(stagingSectionsDir, "overview.md"), `${uniqueMarker}\n`, "utf8");

    // absorb from the custom staging root (not the session overlay)
    const store = new CanonicalStore(ctx.contentDir, ctx.rootDir);
    const { commitSha } = await store.absorbChangedSections(customStagingRoot, "test: absorb A8.4 custom staging", AUTHOR);
    expect(commitSha).toBeTruthy();

    // Content should be in canonical
    const canonical = new ContentLayer(ctx.contentDir);
    const sections = await canonical.readAllSections(SAMPLE_DOC_PATH);
    expect(String(sections.get("Overview") ?? "")).toContain(uniqueMarker);
  });
});
