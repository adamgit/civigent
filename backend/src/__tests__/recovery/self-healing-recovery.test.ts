/**
 * Self-healing recovery tests.
 *
 * These tests document the desired behavior for resilient crash recovery.
 * Most are EXPECTED TO FAIL until the corresponding fix is implemented:
 *
 * - corrupt session skeleton falls back to canonical → Fix: "FragmentStore.fromDisk must always succeed"
 * - orphaned session bodies collected → Fix: "FragmentStore.fromDisk must always succeed"
 * - recovery section appended for orphaned bodies → Fix: "Recovery section generation"
 * - recovery section is a normal editable section → EXPECTED PASS (uses existing skeleton mutation)
 * - recovery section committed to git during startup recovery → Fix: "Recovery section generation"
 * - empty overlay skeleton remains a live empty document → Fix: "Empty-doc format separation"
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentSkeleton, FlatEntry } from "../../storage/document-skeleton.js";
import type { WriterIdentity } from "../../types/shared.js";
import { getHeadSha } from "../../storage/git-repo.js";

function collectFlat(skeleton: DocumentSkeleton): FlatEntry[] {
  const entries: FlatEntry[] = [];
  skeleton.forEachNode((heading, level, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
    entries.push({ heading, level, sectionFile, headingPath: [...headingPath], absolutePath, isSubSkeleton });
  });
  return entries;
}

describe("Self-healing Recovery", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ── Test: corrupt session skeleton falls back to canonical ──

  it("corrupt session skeleton throws instead of silently falling back", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write a session overlay skeleton with duplicate root entries
    // (triggers validateNoDuplicateRoots in DocumentSkeleton.fromDisk)
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionDocDir = join(sessionContentDir, "ops");
    const sessionSectionsDir = `${join(sessionDocDir, "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });

    // Corrupt skeleton: two root entries (impossible state)
    await writeFile(
      join(sessionDocDir, "strategy.md"),
      "{{section: _root.md}}\n{{section: _root2.md}}\n\n## Overview\n{{section: overview.md}}\n",
      "utf8",
    );
    await writeFile(join(sessionSectionsDir, "_root.md"), "root content\n", "utf8");
    await writeFile(join(sessionSectionsDir, "_root2.md"), "duplicate root\n", "utf8");
    await writeFile(join(sessionSectionsDir, "overview.md"), "updated overview\n", "utf8");

    // FragmentStore.fromDisk MUST throw — corruption must not be hidden
    const { FragmentStore } = await import("../../crdt/fragment-store.js");
    await expect(FragmentStore.fromDisk(SAMPLE_DOC_PATH)).rejects.toThrow("duplicate root");
  });

  // ── Test: orphaned session bodies collected ──

  it("orphaned session bodies collected", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write session overlay body files: A, B exist in canonical, "sec_new_section_xyz.md" does not
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionSectionsDir = `${join(sessionContentDir, "ops", "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });

    await writeFile(join(sessionSectionsDir, "overview.md"), "session overview content\n", "utf8");
    await writeFile(join(sessionSectionsDir, "timeline.md"), "session timeline content\n", "utf8");
    await writeFile(join(sessionSectionsDir, "sec_new_section_xyz.md"), "orphaned content from deleted heading\n", "utf8");

    const { FragmentStore } = await import("../../crdt/fragment-store.js");

    const { store, orphanedBodies } = await FragmentStore.fromDisk(SAMPLE_DOC_PATH);

    // orphanedBodies should contain the session file that doesn't match canonical skeleton
    expect(Array.isArray(orphanedBodies)).toBe(true);

    const orphanFiles = orphanedBodies.map(o => o.sectionFile);
    expect(orphanFiles).toContain("sec_new_section_xyz.md");

    store.ydoc.destroy();
  });

  // ── Test: recovery section appended for orphaned bodies ──

  it("recovery section appended for orphaned bodies", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write session overlay with an orphaned body file
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionSectionsDir = `${join(sessionContentDir, "ops", "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });

    await writeFile(join(sessionSectionsDir, "sec_orphan.md"), "orphaned data\n", "utf8");

    // acquireDocSession should detect orphaned bodies and append a recovery section
    const { acquireDocSession, releaseDocSession } = await import("../../crdt/ydoc-lifecycle.js");
    const baseHead = await getHeadSha(ctx.rootDir);
    const writerIdentity: WriterIdentity = { id: "recovery-test-writer", type: "human", displayName: "Recovery Test" };
    const session = await acquireDocSession(SAMPLE_DOC_PATH, "recovery-test-writer", baseHead, writerIdentity);

    // Check that skeleton has a "Recovered edits" section
    const flat = collectFlat(session.fragments.skeleton);
    const recoveryEntry = flat.find(
      (e) => e.heading.toLowerCase().includes("recovered"),
    );
    expect(recoveryEntry).toBeDefined();

    await releaseDocSession(SAMPLE_DOC_PATH);
  });

  // ── Test: recovery section is a normal editable section ──

  it("recovery section is a normal editable section", async () => {
    await createSampleDocument(ctx.rootDir);

    const { DocumentSkeleton, parseSkeletonToEntries, serializeSkeletonEntries } =
      await import("../../storage/document-skeleton.js");

    const contentRoot = join(ctx.rootDir, "content");
    const skeletonPath = join(contentRoot, SAMPLE_DOC_PATH);
    const sectionsDir = `${skeletonPath}.sections`;

    // Manually add a "Recovered edits" section to the skeleton
    const { readFile: readF } = await import("node:fs/promises");
    const skeletonContent = await readF(skeletonPath, "utf8");
    const updatedSkeleton =
      skeletonContent.trimEnd() +
      "\n\n## Recovered edits\n{{section: sec_recovered_edits.md}}\n";
    await writeFile(skeletonPath, updatedSkeleton, "utf8");
    await writeFile(join(sectionsDir, "sec_recovered_edits.md"), "Some recovered content.\n", "utf8");

    // Load skeleton and verify the recovery section exists
    const { DocumentSkeletonInternal } = await import("../../storage/document-skeleton.js");
    const skeleton = await DocumentSkeletonInternal.fromDisk(SAMPLE_DOC_PATH, contentRoot, contentRoot);
    const flat = collectFlat(skeleton);
    const recoveryEntry = flat.find((e) => e.heading === "Recovered edits");
    expect(recoveryEntry).toBeDefined();

    // Delete the recovery section via skeleton.replace (standard mutation)
    await skeleton.replace(["Recovered edits"], []);

    // Verify it's gone
    const flatAfter = collectFlat(skeleton);
    const stillThere = flatAfter.find((e) => e.heading === "Recovered edits");
    expect(stillThere).toBeUndefined();

    // Other sections remain intact
    expect(flatAfter.some((e) => e.heading === "Overview")).toBe(true);
    expect(flatAfter.some((e) => e.heading === "Timeline")).toBe(true);
  });

  // ── Test: recovery section committed to git during startup recovery ──

  it("corrupt overlay with duplicate roots is recovered gracefully", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write a corrupt session skeleton + orphaned body files
    const sessionContentDir = join(ctx.rootDir, "sessions", "docs", "content");
    const sessionDocDir = join(sessionContentDir, "ops");
    const sessionSectionsDir = `${join(sessionDocDir, "strategy.md")}.sections`;
    await mkdir(sessionSectionsDir, { recursive: true });

    // Corrupt skeleton: two root entries (impossible state)
    await writeFile(
      join(sessionDocDir, "strategy.md"),
      "{{section: _root.md}}\n{{section: _root2.md}}\n",
      "utf8",
    );
    await writeFile(join(sessionSectionsDir, "_root.md"), "root\n", "utf8");
    await writeFile(join(sessionSectionsDir, "_root2.md"), "dup root\n", "utf8");
    await writeFile(join(sessionSectionsDir, "sec_lost_work.md"), "important user edits\n", "utf8");

    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    const result = await detectAndRecoverCrash(ctx.rootDir);

    // New recovery pipeline handles duplicate roots gracefully (deduplicates)
    // and recovers all content including orphaned sections
    expect(result.recovered).toBe(true);
    expect(result.sessionFilesRecovered).toBeGreaterThan(0);
  });

  // ── Test: empty overlay skeleton is a live empty document, not a tombstone ──

  it("empty overlay skeleton shadows canonical as a live empty document", async () => {
    await createSampleDocument(ctx.rootDir);

    const contentRoot = join(ctx.rootDir, "content");
    const overlayRoot = join(ctx.rootDir, "sessions", "docs", "content");
    const overlayDocDir = join(overlayRoot, "ops");

    // Write an empty overlay skeleton file (zero bytes)
    await mkdir(overlayDocDir, { recursive: true });
    await writeFile(join(overlayDocDir, "strategy.md"), "", "utf8");

    const { DocumentSkeleton } = await import("../../storage/document-skeleton.js");
    const skeleton = await DocumentSkeleton.fromDisk(SAMPLE_DOC_PATH, overlayRoot, contentRoot);
    // Empty overlay should now remain visible as an empty live document.
    expect(skeleton.overlayPersisted).toBe(true);
    expect(skeleton.overlayTombstoned).toBe(false);
    expect(skeleton.isEmpty).toBe(true);
  });
});
