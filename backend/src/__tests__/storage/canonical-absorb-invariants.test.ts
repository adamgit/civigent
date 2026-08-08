/**
 * Group A8: Canonical Store (absorb) Invariant Tests
 *
 * Pre-refactor invariant tests for CanonicalStore.absorb().
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFile, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getHeadSha, gitStatusPorcelain } from "../../storage/git-repo.js";
import { parseSkeletonToEntries, serializeSkeletonEntries, TOMBSTONE_SUFFIX } from "../../storage/document-skeleton.js";
import { docPathToContentRelativeFsPath } from "../../storage/path-utils.js";
import { DocPath } from "../../types/shared.js";

const AUTHOR = { name: "Absorb Test", email: "absorb@test.local" };

function toDiskRelative(docPath: string): string {
  return docPathToContentRelativeFsPath(DocPath.parse(docPath));
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

    // A successful absorb leaves NOTHING uncommitted under content/. This is the
    // precondition the boot path depends on: `recoverDirtyWorkingTree` hard-exits
    // the server on any dirty tracked content path, so an absorb that mutates
    // canonical without recording it locks the whole app out on the next restart.
    // Asserted here rather than in a bespoke test because it must hold for EVERY
    // successful absorb, whichever pass or git call is at fault.
    const dirtyContentPaths = (await gitStatusPorcelain(ctx.rootDir))
      .filter((entry) => entry.filePath.startsWith("content/"));
    expect(dirtyContentPaths).toEqual([]);
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

  it("A8.3: a failed absorb must not leave canonical mutated", async () => {
    // Read canonical overview content before any operation
    const canonicalSectionsDir = join(ctx.contentDir, toDiskRelative(SAMPLE_DOC_PATH) + ".sections");
    const overviewBefore = await readFile(join(canonicalSectionsDir, "overview.md"), "utf8");
    const headBefore = await getHeadSha(ctx.rootDir);

    // Point the store at a dataRoot that does not exist, so every git call fails
    // (the git child process cannot even spawn with that cwd).
    const badStore = new CanonicalStore(ctx.contentDir, "/nonexistent/data/root");
    const stagingRoot = await createStagingRoot(SAMPLE_DOC_PATH, {
      "overview.md": "This must never reach canonical.",
    });

    // absorb should throw due to git failure
    await expect(
      badStore.absorbChangedSections(stagingRoot, "test: absorb should fail", AUTHOR),
    ).rejects.toThrow();

    const headAfter = await getHeadSha(ctx.rootDir);
    expect(headAfter).toBe(headBefore);

    // THE load-bearing assertion. absorb() is documented as all-or-nothing: if the
    // commit did not land, canonical must read exactly as it did before. Checking
    // HEAD alone is NOT sufficient — "no commit happened" is the SYMPTOM of the
    // failure, not proof of recovery, so a HEAD-only test passes happily while
    // canonical has already been overwritten on disk. Do not weaken this back to
    // "best-effort".
    const overviewAfter = await readFile(join(canonicalSectionsDir, "overview.md"), "utf8");
    expect(overviewAfter).toBe(overviewBefore);
  });

  // ── A8.3b ─────────────────────────────────────────────────────────

  it("A8.3b: a document delete must survive a wedged git repo", async () => {
    // Same invariant as A8.3, different failure injection — and this is the shape
    // that actually took the app down (2026-07-27): a real, working git repo that
    // cannot take the index lock. It behaves differently from A8.3's unspawnable
    // git: `git clean` does not need the index lock and still succeeds, while
    // `git reset` / `git checkout` do and fail. That is precisely why creations
    // roll back correctly here and DELETIONS DO NOT — the rollback only works in
    // the direction that is not destructive. A8.3 alone cannot see that asymmetry.
    const diskRelative = toDiskRelative(SAMPLE_DOC_PATH);
    const canonicalSkeletonPath = join(ctx.contentDir, diskRelative);
    const headBefore = await getHeadSha(ctx.rootDir);

    // Staging for a delete contains ONLY the tombstone marker (no skeleton, no bodies).
    const stagingRoot = join(ctx.rootDir, "test-staging-a83b");
    await mkdir(dirname(join(stagingRoot, diskRelative)), { recursive: true });
    await writeFile(join(stagingRoot, diskRelative + TOMBSTONE_SUFFIX), "deleted\n", "utf8");

    // Wedge the repo the way a killed git child or a concurrent git process does.
    const indexLockPath = join(ctx.rootDir, ".git", "index.lock");
    await writeFile(indexLockPath, "", "utf8");

    try {
      const store = new CanonicalStore(ctx.contentDir, ctx.rootDir);
      await expect(
        store.absorbChangedSections(stagingRoot, "test: delete under wedged git", AUTHOR, {
          // Mirrors the real delete path: commit-pipeline passes the document as a
          // wholesale target, which routes the absorb through the tombstone branch.
          documentPathsToRewrite: [SAMPLE_DOC_PATH],
        }),
      ).rejects.toThrow();

      expect(await getHeadSha(ctx.rootDir)).toBe(headBefore);

      // The commit did not land, so the document must still be here. If it is gone,
      // canonical has been destroyed with no git record of it — the state that makes
      // the server refuse to boot, and which no later run can recover.
      expect(existsSync(canonicalSkeletonPath)).toBe(true);
      expect(existsSync(canonicalSkeletonPath + ".sections")).toBe(true);
    } finally {
      await rm(indexLockPath, { force: true });
    }
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

  // ── A8.5 ──────────────────────────────────────────────────────────

  it("A8.5: AbsorbResult is a session-free receipt, NOT a live Y.Doc delta contract", async () => {
    // Area C invariant: absorb() returns commit-result receipts only. It must
    // not grow Y.Doc rewrite instructions, client/section remap payloads, or any
    // session/DocSession mapping — the committed delta reaches live Y.Docs via
    // the CRDTProposalGenerator Y.transact primitive, not via this result.
    const stagingRoot = await createStagingRoot(SAMPLE_DOC_PATH, {
      "overview.md": `A8.5 receipt-only ${Date.now()}`,
    });

    const store = new CanonicalStore(ctx.contentDir, ctx.rootDir);
    const result = await store.absorbChangedSections(
      stagingRoot,
      "test: absorb A8.5 receipt shape",
      AUTHOR,
      {
        absorbedSectionRefs: [{ docPath: SAMPLE_DOC_PATH, headingPath: ["Overview"] }],
      },
    );

    // The result shape is exactly the four receipt fields — no Y.Doc delta,
    // no client remap, no session/DocSession identity.
    expect(Object.keys(result).sort()).toEqual(
      ["absorbedSectionRefs", "changedSections", "commitSha", "rewrittenDocumentPaths"],
    );
    expect(result).not.toHaveProperty("ydocDelta");
    expect(result).not.toHaveProperty("yDocDelta");
    expect(result).not.toHaveProperty("clientRemap");
    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("docSessionId");
    expect(result).not.toHaveProperty("proposalAdoptionId");

    // Section receipts carry only docPath + headingPath (no fragment keys, no
    // session-overlay mappings).
    for (const ref of [...result.absorbedSectionRefs, ...result.changedSections]) {
      expect(Object.keys(ref).sort()).toEqual(["docPath", "headingPath"]);
    }
  });
});
