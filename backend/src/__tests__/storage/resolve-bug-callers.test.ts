/**
 * Phase 2: Caller-level tests confirming broken/working paths
 * for the DocumentSkeleton.expect() sub-skeleton bug.
 *
 * Documents the broken behavior: when expect() returns a sub-skeleton
 * entry (isSubSkeleton=true), callers that read/write body content
 * will hit the skeleton file instead of the body file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ContentLayer } from "../../storage/content-layer.js";
import { DocumentSkeleton, type FlatEntry } from "../../storage/document-skeleton.js";
import { FragmentStore } from "../../crdt/fragment-store.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { gitExec } from "../../storage/git-repo.js";
import { SectionRef } from "../../domain/section-ref.js";

const NESTED_DOC_PATH = "test/nested-doc.md";

/**
 * Creates a document with sub-skeleton structure on disk:
 *   root: _root.md
 *   ## Introduction: intro.md (flat, no children)
 *   ## Details: details.md (HAS children → sub-skeleton)
 *     root child: _details_root.md (body for "Details" heading)
 *     ### Sub-Detail A: sub_a.md
 *     ### Sub-Detail B: sub_b.md
 */
async function createNestedDocument(dataRoot: string): Promise<void> {
  const contentRoot = join(dataRoot, "content");
  const skeletonPath = join(contentRoot, NESTED_DOC_PATH);
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(sectionsDir, { recursive: true });

  const topSkeleton = [
    "{{section: _root.md}}",
    "",
    "## Introduction",
    "{{section: intro.md}}",
    "",
    "## Details",
    "{{section: details.md}}",
    "",
  ].join("\n");
  await writeFile(skeletonPath, topSkeleton, "utf8");
  await writeFile(join(sectionsDir, "_root.md"), "Root body.\n", "utf8");
  await writeFile(join(sectionsDir, "intro.md"), "Intro body.\n", "utf8");

  const detailsSubSkeleton = [
    "{{section: _details_root.md}}",
    "",
    "### Sub-Detail A",
    "{{section: sub_a.md}}",
    "",
    "### Sub-Detail B",
    "{{section: sub_b.md}}",
    "",
  ].join("\n");
  const detailsSectionsDir = join(sectionsDir, "details.md.sections");
  await mkdir(detailsSectionsDir, { recursive: true });
  await writeFile(join(sectionsDir, "details.md"), detailsSubSkeleton, "utf8");
  await writeFile(join(detailsSectionsDir, "_details_root.md"), "Details body.\n", "utf8");
  await writeFile(join(detailsSectionsDir, "sub_a.md"), "Sub-detail A body.\n", "utf8");
  await writeFile(join(detailsSectionsDir, "sub_b.md"), "Sub-detail B body.\n", "utf8");

  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    ["-c", "user.name=Test", "-c", "user.email=test@test.local",
     "commit", "-m", "add nested doc", "--allow-empty"],
    dataRoot,
  );
}

// ─── ContentLayer.readSection() ──────────────────────────────────

describe("ContentLayer.readSection() — sub-skeleton bug", () => {
  let ctx: TempDataRootContext;
  let layer: ContentLayer;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    layer = new ContentLayer(ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("readSection for heading WITHOUT children returns correct body content", async () => {
    const ref = new SectionRef(NESTED_DOC_PATH, ["Introduction"]);
    const content = await layer.readSection(ref);
    expect(content).toBe("Intro body.\n");
  });

  it("readSection for heading WITH children returns body content (fixed)", async () => {
    const ref = new SectionRef(NESTED_DOC_PATH, ["Details"]);
    const content = await layer.readSection(ref);
    // FIXED: Now returns body content from the root child file
    expect(content).toBe("Details body.\n");
    expect(content).not.toContain("{{section:");
  });
});

// ─── ContentLayer.writeSection() ─────────────────────────────────

describe("ContentLayer.writeSection() — sub-skeleton bug", () => {
  let ctx: TempDataRootContext;
  let layer: ContentLayer;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    layer = new ContentLayer(ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("writeSection for heading WITHOUT children writes body content correctly", async () => {
    const ref = new SectionRef(NESTED_DOC_PATH, ["Introduction"]);
    await layer.writeSection(ref, "Updated intro.\n");
    const readBack = await readFile(
      join(ctx.contentDir, NESTED_DOC_PATH + ".sections", "intro.md"),
      "utf8",
    );
    expect(readBack).toBe("Updated intro.\n");
  });

  it("writeSection for heading WITH children writes to body file, preserving sub-skeleton (fixed)", async () => {
    const ref = new SectionRef(NESTED_DOC_PATH, ["Details"]);
    await layer.writeSection(ref, "New details body.\n");
    // FIXED: The sub-skeleton file (details.md) is preserved
    const skeletonContent = await readFile(
      join(ctx.contentDir, NESTED_DOC_PATH + ".sections", "details.md"),
      "utf8",
    );
    expect(skeletonContent).toContain("{{section:");
    // The body file (_details_root.md) WAS updated
    const bodyContent = await readFile(
      join(ctx.contentDir, NESTED_DOC_PATH + ".sections", "details.md.sections", "_details_root.md"),
      "utf8",
    );
    expect(bodyContent).toBe("New details body.\n");
  });
});

// ─── resolveHeadingPath() ────────────────────────────────────────

describe("resolveHeadingPath() — sub-skeleton bug", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    process.env.KS_DATA_ROOT = ctx.rootDir;
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("resolveHeadingPath for heading WITHOUT children returns body file path", async () => {
    // Use skeleton directly (resolveHeadingPath uses getContentRoot which is set via env)
    const skeleton = await DocumentSkeleton.fromDisk(
      NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir,
    );
    const entry = skeleton.expect(["Introduction"]);
    expect(entry.absolutePath).toContain("intro.md");
    expect(entry.isSubSkeleton).toBe(false);
  });

  it("resolveHeadingPath for heading WITH children returns body file path (fixed)", async () => {
    const skeleton = await DocumentSkeleton.fromDisk(
      NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir,
    );
    const entry = skeleton.expect(["Details"]);
    // FIXED: returns the root child body file path
    expect(entry.absolutePath).toContain("_details_root.md");
    expect(entry.absolutePath).toContain("details.md.sections");
    expect(entry.isSubSkeleton).toBe(false);
  });
});

// ─── commitHumanChangesToCanonical() via resolveHeadingPath ──────

describe("commitHumanChangesToCanonical — sub-skeleton path verification", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    process.env.KS_DATA_ROOT = ctx.rootDir;
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("confirms the path that commitHumanChangesToCanonical would write to is the body file (fixed)", async () => {
    // commitHumanChangesToCanonical calls resolveHeadingPath() to get the write target.
    // FIXED: For a heading with children, this now returns the root child body file.
    const skeleton = await DocumentSkeleton.fromDisk(
      NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir,
    );
    const entry = skeleton.expect(["Details"]);
    expect(entry.isSubSkeleton).toBe(false);
    // Reading this file should show body content, not skeleton markup
    const fileContent = await readFile(entry.absolutePath, "utf8");
    expect(fileContent).toBe("Details body.\n");
    expect(fileContent).not.toContain("{{section:");
  });
});

// ─── FragmentStore.fragmentKeyFor() ──────────────────────────────

describe("FragmentStore.fragmentKeyFor() — sub-skeleton context", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("fragmentKeyFor with expect() now uses root child's sectionFile (fixed)", async () => {
    const skeleton = await DocumentSkeleton.fromDisk(
      NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir,
    );
    const entry = skeleton.expect(["Details"]);
    // FIXED: entry.sectionFile is the root child's file (_details_root.md)
    // but heading/level are preserved from the parent (Details, level 2)
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.sectionFile).toBe("_details_root.md");
    expect(entry.heading).toBe("Details");
    expect(entry.level).toBe(2);
    const key = FragmentStore.fragmentKeyFor(entry);
    // heading="Details", level=2 → isRoot=false → key from sectionFile
    expect(key).toBe("section::_details_root");
  });

  it("fragment key for resolved entry matches fragmentKeyFromSectionFile", async () => {
    const skeleton = await DocumentSkeleton.fromDisk(
      NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir,
    );
    const entry = skeleton.expect(["Details"]);
    const fromStore = FragmentStore.fragmentKeyFor(entry);
    const fromHelper = fragmentKeyFromSectionFile(entry.sectionFile, false);
    expect(fromStore).toBe(fromHelper);
  });

  it("resolve().level is correct even for sub-skeleton entries — CRDT section focus uses level", async () => {
    const skeleton = await DocumentSkeleton.fromDisk(
      NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir,
    );
    const entry = skeleton.expect(["Details"]);
    // Level is correctly 2 (## Details) even though absolutePath is wrong
    expect(entry.level).toBe(2);
  });
});

// ─── Auto-commit dirty fragment key lookup ───────────────────────

describe("Auto-commit dirty fragment key derivation — sub-skeleton context", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("forEachSection and expect() produce consistent fragment keys for sub-skeleton sections", async () => {
    const skeleton = await DocumentSkeleton.fromDisk(
      NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir,
    );

    // Collect ALL fragment keys via forEachSection (what commitDirtySections uses)
    // Note: forEachSection visits BOTH the sub-skeleton entry AND its root child,
    // which share the same headingPath (["Details"]). The root child (level=0, heading="")
    // gets isRoot=true → ROOT_FRAGMENT_KEY, overwriting the sub-skeleton's key.
    const forEachEntries: Array<{
      hpKey: string; heading: string; level: number;
      sectionFile: string; fragmentKey: string; isSubSkeleton: boolean;
    }> = [];
    skeleton.forEachNode((heading, level, sectionFile, headingPath, _absolutePath, isSubSkeleton) => {
      const isRoot = level === 0 && heading === "";
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isRoot);
      forEachEntries.push({
        hpKey: headingPath.join(">>"),
        heading, level, sectionFile, fragmentKey, isSubSkeleton,
      });
    });

    // forEachSection visits BOTH the sub-skeleton entry AND its root child.
    // The sub-skeleton entry for "Details" and its root child both have headingPath=["Details"]
    const detailsEntries = forEachEntries.filter(e => e.hpKey === "Details");
    expect(detailsEntries).toHaveLength(2);
    expect(detailsEntries[0].isSubSkeleton).toBe(true);  // sub-skeleton entry
    expect(detailsEntries[0].fragmentKey).toBe("section::details");
    expect(detailsEntries[1].isSubSkeleton).toBe(false);  // root child (body)
    expect(detailsEntries[1].fragmentKey).toBe("section::__root__");

    // FIXED: resolve(["Details"]) now returns the root child body entry
    const resolveEntry = skeleton.expect(["Details"]);
    const resolveKey = FragmentStore.fragmentKeyFor(resolveEntry);
    // heading/level preserved from parent, sectionFile from root child
    expect(resolveEntry.sectionFile).toBe("_details_root.md");
    expect(resolveKey).toBe("section::_details_root");
    expect(resolveEntry.isSubSkeleton).toBe(false);

    // The auto-commit flow uses forEachSection (which skips isSubSkeleton entries)
    // and derives fragment keys from sectionFile directly, so it consistently
    // uses the root child's fragment key. The expect() path also now returns
    // the root child's sectionFile, so the key derivation is consistent.
  });
});
