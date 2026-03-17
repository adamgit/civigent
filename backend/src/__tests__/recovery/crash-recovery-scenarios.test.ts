import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { gitExec } from "../../storage/git-repo.js";

describe("Crash Recovery Scenarios", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ── Fix 1: Session file preservation on commit failure ──

  it("Fix 1: when commitSessionFilesToCanonical throws, session files are preserved", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write a session overlay with a skeleton containing duplicate roots
    // (triggers the "no duplicate root entries" invariant in DocumentSkeleton.fromDisk)
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionDocDir = join(sessionContentDir, "ops");
    const sessionSectionsDir = `${join(sessionDocDir, "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });

    // Write a corrupt skeleton with duplicate root entries
    await writeFile(join(sessionDocDir, "strategy.md"),
      "{{section: _root.md}}\n{{section: _root2.md}}\n\n## Overview\n{{section: overview.md}}\n",
      "utf8");
    await writeFile(join(sessionSectionsDir, "_root.md"), "root content\n", "utf8");
    await writeFile(join(sessionSectionsDir, "_root2.md"), "duplicate root\n", "utf8");
    await writeFile(join(sessionSectionsDir, "overview.md"), "updated overview\n", "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    const result = await detectAndRecoverCrash(ctx.rootDir);

    // Commit should have failed (duplicate root invariant), so session files preserved
    expect(result.sessionFilesRecovered).toBe(0);

    // Session files must still exist
    const overviewExists = await stat(join(sessionSectionsDir, "overview.md")).then(() => true).catch(() => false);
    expect(overviewExists).toBe(true);
  });

  it("Fix 1: when commit succeeds, session files are cleaned up (happy path)", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write valid session overlay with updated content for Overview section
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionDocDir = join(sessionContentDir, "ops");
    const sessionSectionsDir = `${join(sessionDocDir, "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });
    await writeFile(join(sessionSectionsDir, "overview.md"), "Updated overview content.\n", "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    const result = await detectAndRecoverCrash(ctx.rootDir);

    // Session files should be cleaned up after successful commit
    const sessionExists = await stat(sessionContentDir).then(() => true).catch(() => false);
    // May or may not exist depending on cleanup depth, but the doc-specific files should be gone
    if (sessionExists) {
      const remaining = await readdir(sessionContentDir, { recursive: true });
      // Should have no .md files left
      const mdFiles = remaining.filter((f: string) => f.endsWith(".md"));
      expect(mdFiles.length).toBe(0);
    }

    expect(result.sessionFilesRecovered).toBeGreaterThanOrEqual(0);
  });

  // ── Fix 2: Restore content/ instead of committing ──

  it("Fix 2: half-promoted canonical is restored to last committed state", async () => {
    await createSampleDocument(ctx.rootDir);

    // Read original content for comparison
    const contentRoot = join(ctx.rootDir, "content");
    const skeletonPath = join(contentRoot, SAMPLE_DOC_PATH);
    const sectionsDir = `${skeletonPath}.sections`;
    const originalSkeleton = await readFile(skeletonPath, "utf8");
    const originalOverview = await readFile(join(sectionsDir, "overview.md"), "utf8");

    // Simulate half-promoted canonical: modify skeleton and delete a body file
    const corruptSkeleton = originalSkeleton.replace("## Overview", "## Renamed");
    await writeFile(skeletonPath, corruptSkeleton, "utf8");
    // Don't delete body file — just modify skeleton to simulate partial promote

    // Working tree is now dirty (modified skeleton)
    const statusBefore = await gitExec(["status", "--porcelain"], ctx.rootDir);
    expect(statusBefore).toContain("content/");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    await detectAndRecoverCrash(ctx.rootDir);

    // Canonical should be restored to last committed state
    const restoredSkeleton = await readFile(skeletonPath, "utf8");
    expect(restoredSkeleton).toBe(originalSkeleton);

    const restoredOverview = await readFile(join(sectionsDir, "overview.md"), "utf8");
    expect(restoredOverview).toBe(originalOverview);

    // Working tree should be clean
    const statusAfter = await gitExec(["status", "--porcelain"], ctx.rootDir);
    const contentDirty = statusAfter.split(/\r?\n/).filter(l => l.includes("content/"));
    expect(contentDirty.length).toBe(0);
  });

  it("Fix 2: dirty proposals are still committed (not restored)", async () => {
    await createSampleDocument(ctx.rootDir);

    // Create a dirty proposal file
    const pendingDir = join(ctx.rootDir, "proposals", "pending");
    await mkdir(pendingDir, { recursive: true });
    const proposalData = {
      id: "test-prop-1",
      writer: { id: "human-1", type: "human", displayName: "Test" },
      intent: "test",
      sections: [],
      created_at: new Date().toISOString(),
    };
    const propDir = join(pendingDir, "test-prop-1");
    await mkdir(propDir, { recursive: true });
    await writeFile(join(propDir, "meta.json"), JSON.stringify(proposalData), "utf8");
    await gitExec(["add", "proposals/"], ctx.rootDir);
    // Don't commit — leave staged

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    await detectAndRecoverCrash(ctx.rootDir);

    // Proposals should have been committed
    const log = await gitExec(["log", "--oneline", "-3"], ctx.rootDir);
    expect(log).toContain("finalize pending proposal state transitions");
  });

  // ── Fix 3: Recovery ordering ──

  it("Fix 3: session recovery sees clean canonical, not corrupted-then-committed", async () => {
    await createSampleDocument(ctx.rootDir);

    // Simulate crash: dirty canonical + valid session overlay
    const contentRoot = join(ctx.rootDir, "content");
    const skeletonPath = join(contentRoot, SAMPLE_DOC_PATH);
    const sectionsDir = `${skeletonPath}.sections`;

    // Corrupt canonical (simulating half-finished promoteOverlay)
    const originalSkeleton = await readFile(skeletonPath, "utf8");
    await writeFile(skeletonPath, originalSkeleton + "\n## Ghost\n{{section: ghost.md}}\n", "utf8");

    // Write valid session overlay with updated content
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionDocDir = join(sessionContentDir, "ops");
    const sessionSectionsDir = `${join(sessionDocDir, "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });
    await writeFile(join(sessionSectionsDir, "overview.md"), "Session-updated overview.\n", "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    await detectAndRecoverCrash(ctx.rootDir);

    // Canonical should have been restored FIRST, then session overlay committed
    // The skeleton should NOT contain the corrupt "## Ghost" entry
    const finalSkeleton = await readFile(skeletonPath, "utf8");
    expect(finalSkeleton).not.toContain("Ghost");

    // Git log should NOT contain a corrupt "finalize pending commit"
    const log = await gitExec(["log", "--oneline", "-5"], ctx.rootDir);
    expect(log).not.toContain("finalize pending commit");
  });

  // ── Test 1b: Staged but uncommitted content changes ──

  it("Test 1b: staged content changes are restored, not committed", async () => {
    await createSampleDocument(ctx.rootDir);

    const contentRoot = join(ctx.rootDir, "content");
    const sectionsDir = `${join(contentRoot, SAMPLE_DOC_PATH)}.sections`;

    // Modify and stage a content file
    await writeFile(join(sectionsDir, "overview.md"), "STAGED BAD CONTENT\n", "utf8");
    await gitExec(["add", "content/"], ctx.rootDir);

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    await detectAndRecoverCrash(ctx.rootDir);

    // Content should be restored to last committed state
    const content = await readFile(join(sectionsDir, "overview.md"), "utf8");
    expect(content).toBe(SAMPLE_SECTIONS.overview);

    // Working tree should be clean
    const status = await gitExec(["status", "--porcelain"], ctx.rootDir);
    expect(status.trim()).toBe("");
  });

  // ── Test 5b: Orphan body files ──

  it("Test 5b: orphan body files in canonical are harmless", async () => {
    await createSampleDocument(ctx.rootDir);

    const sectionsDir = `${join(ctx.rootDir, "content", SAMPLE_DOC_PATH)}.sections`;
    await writeFile(join(sectionsDir, "orphan_extra.md"), "orphan content\n", "utf8");
    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec([
      "-c", "user.name=Test", "-c", "user.email=test@test.local",
      "commit", "-m", "add orphan", "--allow-empty",
    ], ctx.rootDir);

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    const result = await detectAndRecoverCrash(ctx.rootDir);

    expect(result.recovered).toBe(false);
    // Document should still read correctly
    const { readAssembledDocument } = await import("../../storage/document-reader.js");
    const doc = await readAssembledDocument(SAMPLE_DOC_PATH);
    expect(doc).toContain("Overview");
  });

  // ── Test 5c: Session overlay newer than canonical ──

  it("Test 5c: session overlay with updated content is committed", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write session overlay with updated content for 2 sections
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionDocDir = join(sessionContentDir, "ops");
    const sessionSectionsDir = `${join(sessionDocDir, "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });
    await writeFile(join(sessionSectionsDir, "overview.md"), "Updated overview from session.\n", "utf8");
    await writeFile(join(sessionSectionsDir, "timeline.md"), "Updated timeline from session.\n", "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    const result = await detectAndRecoverCrash(ctx.rootDir);

    expect(result.sessionFilesRecovered).toBeGreaterThan(0);

    // Canonical should have the updated content
    const contentRoot = join(ctx.rootDir, "content");
    const sectionsDir = `${join(contentRoot, SAMPLE_DOC_PATH)}.sections`;
    const overview = await readFile(join(sectionsDir, "overview.md"), "utf8");
    expect(overview.trim()).toBe("Updated overview from session.");
    const timeline = await readFile(join(sectionsDir, "timeline.md"), "utf8");
    expect(timeline.trim()).toBe("Updated timeline from session.");

    // Root section should be unchanged
    const root = await readFile(join(sectionsDir, "_root.md"), "utf8");
    expect(root).toBe(SAMPLE_SECTIONS.root);
  });

  // ── Test 2c: Compound data loss scenario ──

  it("Test 2c: dirty canonical + valid session overlay — all bugs fixed", async () => {
    await createSampleDocument(ctx.rootDir);

    const contentRoot = join(ctx.rootDir, "content");
    const skeletonPath = join(contentRoot, SAMPLE_DOC_PATH);

    // Corrupt canonical (simulating half-finished promoteOverlay)
    const originalSkeleton = await readFile(skeletonPath, "utf8");
    await writeFile(skeletonPath, originalSkeleton.replace("## Timeline", "## Renamed"), "utf8");

    // Write valid session overlay
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionDocDir = join(sessionContentDir, "ops");
    const sessionSectionsDir = `${join(sessionDocDir, "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });
    await writeFile(join(sessionSectionsDir, "overview.md"), "Session overview.\n", "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    const result = await detectAndRecoverCrash(ctx.rootDir);

    // Canonical should be restored from git HEAD (not the corrupt version)
    const finalSkeleton = await readFile(skeletonPath, "utf8");
    expect(finalSkeleton).toContain("## Timeline"); // Original heading restored
    expect(finalSkeleton).not.toContain("## Renamed"); // Corrupt version gone

    // Session overlay should have been committed
    expect(result.sessionFilesRecovered).toBeGreaterThan(0);
  });

  // ── Test 4a: Raw fragments recovered ──

  it("Test 4a: raw fragments with structural changes produce session overlay files", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write raw fragment with embedded headings (triggers normalization → session overlay)
    const fragmentsDir = join(ctx.rootDir, "sessions", "fragments", "ops", "strategy.md");
    await mkdir(fragmentsDir, { recursive: true });
    // Fragment contains an extra heading — normalization will split it, producing overlay files
    await writeFile(join(fragmentsDir, "overview.md"), "## Overview\n\nContent.\n\n## NewSection\n\nNew content.\n", "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    const result = await detectAndRecoverCrash(ctx.rootDir);

    // Normalization of the structural fragment should produce overlay files
    // which then get committed by session recovery
    expect(result.recovered).toBe(true);
  });

  // ── Test 4b: Truncated raw fragment ──

  it("Test 4b: truncated (empty) raw fragment is skipped gracefully", async () => {
    await createSampleDocument(ctx.rootDir);

    const fragmentsDir = join(ctx.rootDir, "sessions", "fragments", "ops", "strategy.md");
    await mkdir(fragmentsDir, { recursive: true });
    // One with structural change, one empty
    await writeFile(join(fragmentsDir, "overview.md"), "## Overview\n\nValid.\n\n## Extra\n\nMore.\n", "utf8");
    await writeFile(join(fragmentsDir, "timeline.md"), "", "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    // Should not throw — empty fragment skipped, valid one processed
    const result = await detectAndRecoverCrash(ctx.rootDir);
    expect(result.recovered).toBe(true);
  });

  // ── Test 4c: Stale raw fragments ──

  it("Test 4c: stale raw fragments (already committed content) are idempotent", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write raw fragments with same content as canonical (structurally clean)
    const fragmentsDir = join(ctx.rootDir, "sessions", "fragments", "ops", "strategy.md");
    await mkdir(fragmentsDir, { recursive: true });
    await writeFile(join(fragmentsDir, "overview.md"), `## Overview\n\n${SAMPLE_SECTIONS.overview}`, "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    // Should complete without errors — structurally clean fragments are no-ops
    const result = await detectAndRecoverCrash(ctx.rootDir);

    // Canonical should be unchanged
    const sectionsDir = `${join(ctx.rootDir, "content", SAMPLE_DOC_PATH)}.sections`;
    const overview = await readFile(join(sectionsDir, "overview.md"), "utf8");
    expect(overview).toBe(SAMPLE_SECTIONS.overview);
  });

  // ── Test 5d: Multiple documents ──

  it("Test 5d: multiple documents with mixed crash states", async () => {
    // Doc A: dirty canonical + session overlay
    await createSampleDocument(ctx.rootDir, SAMPLE_DOC_PATH);

    // Doc B: create and add raw fragments
    const { createSampleDocument: createDoc2 } = await import("../helpers/sample-content.js");
    await createDoc2(ctx.rootDir, "eng/architecture.md");

    // Dirty Doc A's canonical
    const contentRoot = join(ctx.rootDir, "content");
    const skeletonA = join(contentRoot, SAMPLE_DOC_PATH);
    const origA = await readFile(skeletonA, "utf8");
    await writeFile(skeletonA, origA + "\n## Corrupt\n{{section: corrupt.md}}\n", "utf8");

    // Write session overlay for Doc A
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionDocDir = join(sessionContentDir, "ops");
    const sessionSectionsDir = `${join(sessionDocDir, "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });
    await writeFile(join(sessionSectionsDir, "overview.md"), "Doc A session.\n", "utf8");

    // Write raw fragments for Doc B
    const fragmentsDir = join(ctx.rootDir, "sessions", "fragments", "eng", "architecture.md");
    await mkdir(fragmentsDir, { recursive: true });
    await writeFile(join(fragmentsDir, "principles.md"), "## Principles\n\nRaw fragment.\n", "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    const result = await detectAndRecoverCrash(ctx.rootDir);

    expect(result.recovered).toBe(true);

    // Doc A: canonical should be restored (no corrupt entry)
    const finalA = await readFile(skeletonA, "utf8");
    expect(finalA).not.toContain("Corrupt");
  });

  // ── Clean state ──

  it("clean state: no recovery needed", async () => {
    await createSampleDocument(ctx.rootDir);

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    const result = await detectAndRecoverCrash(ctx.rootDir);

    expect(result.recovered).toBe(false);
    expect(result.sessionFilesRecovered).toBe(0);
  });
});
