/**
 * Test: absorb prunes empty content directories after document deletion/move.
 *
 * Folders in the Knowledge Store are implicit — they exist only because
 * documents live inside them. When the last document is deleted or moved
 * out of a folder, the empty directory should be removed automatically.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { CanonicalStore } from "../../storage/canonical-store.js";
import { TOMBSTONE_SUFFIX } from "../../storage/document-skeleton.js";

describe("CanonicalStore empty content directory pruning", () => {
  let ctx: TempDataRootContext;
  let store: CanonicalStore;
  const author = { name: "test", email: "test@test.com" };

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    store = new CanonicalStore(ctx.contentDir, ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("prunes empty parent folder when last document is tombstoned", async () => {
    // Create a document inside a subfolder: team/notes.md
    const staging1 = join(ctx.rootDir, "staging-prune-1");
    const folderDir = join(staging1, "team");
    await mkdir(folderDir, { recursive: true });
    await writeFile(join(folderDir, "notes.md"), "{{section: sec_a.md}}\n");
    await mkdir(join(folderDir, "notes.md.sections"), { recursive: true });
    await writeFile(join(folderDir, "notes.md.sections", "sec_a.md"), "some notes\n");

    await store.absorbChangedSections(staging1, "create team/notes.md", author);

    // Verify the folder exists in canonical
    expect(existsSync(join(ctx.contentDir, "team"))).toBe(true);
    expect(existsSync(join(ctx.contentDir, "team", "notes.md"))).toBe(true);

    // Tombstone the document — staging contains only the tombstone marker
    const staging2 = join(ctx.rootDir, "staging-prune-2");
    const tombstoneDir = join(staging2, "team");
    await mkdir(tombstoneDir, { recursive: true });
    await writeFile(join(tombstoneDir, "notes.md" + TOMBSTONE_SUFFIX), "deleted\n");

    await store.absorbChangedSections(staging2, "delete team/notes.md", author);

    // The document and its .sections/ should be gone
    expect(existsSync(join(ctx.contentDir, "team", "notes.md"))).toBe(false);
    expect(existsSync(join(ctx.contentDir, "team", "notes.md.sections"))).toBe(false);

    // The now-empty "team/" folder should also be pruned
    expect(existsSync(join(ctx.contentDir, "team"))).toBe(false);
  });

  it("prunes nested empty folders bottom-up", async () => {
    // Create a deeply nested doc: dept/eng/docs/spec.md
    const staging1 = join(ctx.rootDir, "staging-deep-1");
    const deepDir = join(staging1, "dept", "eng", "docs");
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, "spec.md"), "{{section: sec_b.md}}\n");
    await mkdir(join(deepDir, "spec.md.sections"), { recursive: true });
    await writeFile(join(deepDir, "spec.md.sections", "sec_b.md"), "spec content\n");

    await store.absorbChangedSections(staging1, "create nested doc", author);

    expect(existsSync(join(ctx.contentDir, "dept", "eng", "docs", "spec.md"))).toBe(true);

    // Tombstone it
    const staging2 = join(ctx.rootDir, "staging-deep-2");
    const tombstoneDeepDir = join(staging2, "dept", "eng", "docs");
    await mkdir(tombstoneDeepDir, { recursive: true });
    await writeFile(join(tombstoneDeepDir, "spec.md" + TOMBSTONE_SUFFIX), "deleted\n");

    await store.absorbChangedSections(staging2, "delete nested doc", author);

    // All ancestor folders should be pruned since they're all empty
    expect(existsSync(join(ctx.contentDir, "dept", "eng", "docs"))).toBe(false);
    expect(existsSync(join(ctx.contentDir, "dept", "eng"))).toBe(false);
    expect(existsSync(join(ctx.contentDir, "dept"))).toBe(false);
  });

  it("does NOT prune folder that still contains another document", async () => {
    // Create two documents in the same folder: shared/a.md and shared/b.md
    const staging1 = join(ctx.rootDir, "staging-keep-1");
    const sharedDir = join(staging1, "shared");
    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(sharedDir, "a.md"), "{{section: sec_c.md}}\n");
    await mkdir(join(sharedDir, "a.md.sections"), { recursive: true });
    await writeFile(join(sharedDir, "a.md.sections", "sec_c.md"), "doc a\n");
    await writeFile(join(sharedDir, "b.md"), "{{section: sec_d.md}}\n");
    await mkdir(join(sharedDir, "b.md.sections"), { recursive: true });
    await writeFile(join(sharedDir, "b.md.sections", "sec_d.md"), "doc b\n");

    await store.absorbChangedSections(staging1, "create two docs in shared/", author);

    expect(existsSync(join(ctx.contentDir, "shared", "a.md"))).toBe(true);
    expect(existsSync(join(ctx.contentDir, "shared", "b.md"))).toBe(true);

    // Delete only a.md
    const staging2 = join(ctx.rootDir, "staging-keep-2");
    const tombstoneSharedDir = join(staging2, "shared");
    await mkdir(tombstoneSharedDir, { recursive: true });
    await writeFile(join(tombstoneSharedDir, "a.md" + TOMBSTONE_SUFFIX), "deleted\n");

    await store.absorbChangedSections(staging2, "delete shared/a.md only", author);

    // a.md gone, but shared/ still has b.md — folder must remain
    expect(existsSync(join(ctx.contentDir, "shared", "a.md"))).toBe(false);
    expect(existsSync(join(ctx.contentDir, "shared", "b.md"))).toBe(true);
    expect(existsSync(join(ctx.contentDir, "shared"))).toBe(true);
  });

  it("prunes only the leaf folder when parent still has a sibling subfolder", async () => {
    // Create: parent/alpha/one.md and parent/beta/two.md
    const staging1 = join(ctx.rootDir, "staging-sibling-1");
    const alphaDir = join(staging1, "parent", "alpha");
    const betaDir = join(staging1, "parent", "beta");
    await mkdir(alphaDir, { recursive: true });
    await mkdir(betaDir, { recursive: true });
    await writeFile(join(alphaDir, "one.md"), "{{section: sec_e.md}}\n");
    await mkdir(join(alphaDir, "one.md.sections"), { recursive: true });
    await writeFile(join(alphaDir, "one.md.sections", "sec_e.md"), "alpha doc\n");
    await writeFile(join(betaDir, "two.md"), "{{section: sec_f.md}}\n");
    await mkdir(join(betaDir, "two.md.sections"), { recursive: true });
    await writeFile(join(betaDir, "two.md.sections", "sec_f.md"), "beta doc\n");

    await store.absorbChangedSections(staging1, "create alpha + beta", author);

    // Delete only alpha/one.md
    const staging2 = join(ctx.rootDir, "staging-sibling-2");
    const tombstoneAlpha = join(staging2, "parent", "alpha");
    await mkdir(tombstoneAlpha, { recursive: true });
    await writeFile(join(tombstoneAlpha, "one.md" + TOMBSTONE_SUFFIX), "deleted\n");

    await store.absorbChangedSections(staging2, "delete alpha/one.md", author);

    // alpha/ should be pruned (empty), but parent/ stays (has beta/)
    expect(existsSync(join(ctx.contentDir, "parent", "alpha"))).toBe(false);
    expect(existsSync(join(ctx.contentDir, "parent", "beta", "two.md"))).toBe(true);
    expect(existsSync(join(ctx.contentDir, "parent"))).toBe(true);
  });

  it("emits diagnostics for pruned directories", async () => {
    // Create and then delete a doc in a folder, capturing diagnostics
    const staging1 = join(ctx.rootDir, "staging-diag-1");
    const diagDir = join(staging1, "diagfolder");
    await mkdir(diagDir, { recursive: true });
    await writeFile(join(diagDir, "temp.md"), "{{section: sec_g.md}}\n");
    await mkdir(join(diagDir, "temp.md.sections"), { recursive: true });
    await writeFile(join(diagDir, "temp.md.sections", "sec_g.md"), "temp content\n");

    await store.absorbChangedSections(staging1, "create diagfolder/temp.md", author);

    const staging2 = join(ctx.rootDir, "staging-diag-2");
    const tombstoneDiagDir = join(staging2, "diagfolder");
    await mkdir(tombstoneDiagDir, { recursive: true });
    await writeFile(join(tombstoneDiagDir, "temp.md" + TOMBSTONE_SUFFIX), "deleted\n");

    const diagnostics: string[] = [];
    await store.absorbChangedSections(staging2, "delete diagfolder/temp.md", author, {
      diagnostics,
    });

    const pruneMessages = diagnostics.filter((d) => d.includes("pruned empty content directory"));
    expect(pruneMessages.length).toBeGreaterThanOrEqual(1);
    expect(pruneMessages.some((m) => m.includes("diagfolder"))).toBe(true);
  });
});
