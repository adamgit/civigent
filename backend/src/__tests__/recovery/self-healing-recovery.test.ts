/**
 * Self-healing recovery tests.
 *
 * After items 331-347 (DocumentFragments redesign), session acquisition no longer
 * performs orphan-body scans or appends "Recovered edits" sections — that
 * behavior was an anti-pattern bolted into the deleted `FragmentStore.fromDisk(...)`
 * factory. Real crash recovery now lives ONLY in `storage/crash-recovery.ts` and
 * runs at server start. This test file covers the surviving non-recovery
 * invariants (corruption-must-throw, manual recovery-section editability,
 * end-to-end crash-recovery pipeline, empty-overlay live-doc semantics).
 *
 * The old "orphaned session bodies collected" and "recovery section appended for
 * orphaned bodies" tests were deleted along with item 343 — they tested behavior
 * that no longer exists. Crash recovery itself is exhaustively covered by the
 * sibling files `crash-recovery.test.ts`, `crash-recovery-gaps.test.ts`, and
 * `crash-recovery-scenarios.test.ts` in this directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentSkeleton, FlatEntry } from "../../storage/document-skeleton.js";

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

  // ── Test: corrupt session skeleton throws (corruption must not be hidden) ──

  it("corrupt session skeleton throws instead of silently falling back", async () => {
    await createSampleDocument(ctx.rootDir);

    // Write a session overlay skeleton with duplicate root entries
    // (triggers validateNoDuplicateRoots in DocumentSkeleton.fromDisk)
    const sessionContentDir = join(ctx.rootDir, "sessions", "sections", "content");
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

    // The corruption is detected by the skeleton-load layer (validateNoDuplicateRoots),
    // which is the layer the explicit acquireDocSession sequence calls. Item 333 deleted
    // the self-loading FragmentStore.fromDisk wrapper, so the test now exercises the
    // skeleton primitive directly — same call site, same throw, same invariant.
    const { DocumentSkeletonInternal } = await import("../../storage/document-skeleton.js");
    const { getContentRoot, getSessionSectionsContentRoot } = await import("../../storage/data-root.js");
    await expect(
      DocumentSkeletonInternal.fromDisk(SAMPLE_DOC_PATH, getSessionSectionsContentRoot(), getContentRoot()),
    ).rejects.toThrow("duplicate root");
  });

  // NOTE: the previous "orphaned session bodies collected" and "recovery section
  // appended for orphaned bodies" tests were deleted alongside item 343. Both
  // tested behavior that lived inside the deleted FragmentStore.fromDisk recovery
  // branch, which item 343 explicitly removed because crash recovery is illegal
  // outside of server-start crash-recovery.ts. The end-to-end crash recovery
  // pipeline (which IS legal) is covered in `crash-recovery*.test.ts`.

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
    const skeleton = await DocumentSkeletonInternal.mutableFromDisk(SAMPLE_DOC_PATH, contentRoot, contentRoot);
    const flat = collectFlat(skeleton);
    const recoveryEntry = flat.find((e) => e.heading === "Recovered edits");
    expect(recoveryEntry).toBeDefined();

    // Delete the recovery section via the dedicated DSInternal heading-deletion
    // operation (item 143). This is the sanctioned replacement for the deleted
    // `replace([target], [])` primitive — it internalizes previous-section
    // selection, body-merge target derivation, and body-holder side effects.
    await skeleton.deleteHeadingPreservingBody(["Recovered edits"]);

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
    const sessionContentDir = join(ctx.rootDir, "sessions", "sections", "content");
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
    const overlayRoot = join(ctx.rootDir, "sessions", "sections", "content");
    const overlayDocDir = join(overlayRoot, "ops");

    // Write an empty overlay skeleton file (zero bytes)
    await mkdir(overlayDocDir, { recursive: true });
    await writeFile(join(overlayDocDir, "strategy.md"), "", "utf8");

    const { DocumentSkeleton } = await import("../../storage/document-skeleton.js");
    const skeleton = await DocumentSkeleton.fromDisk(SAMPLE_DOC_PATH, overlayRoot, contentRoot);
    // Empty overlay should now remain visible as an empty live document.
    // `loadedFromOverlay` reflects that the overlay file (even though empty)
    // won structure resolution and shadowed the canonical document — this is
    // exactly the semantic the deleted `overlayPersisted` getter expressed
    // here (item 137/159 split).
    expect(skeleton.loadedFromOverlay).toBe(true);
    expect(skeleton.isTombstonedInOverlay).toBe(false);
    expect(skeleton.areSkeletonRootsEmpty).toBe(true);
  });
});
