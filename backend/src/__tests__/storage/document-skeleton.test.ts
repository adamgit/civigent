import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { gitExec } from "../../storage/git-repo.js";

describe("DocumentSkeleton", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("fromDisk reads skeleton file and resolves section entries", async () => {
    const skeleton = await DocumentSkeleton.fromDisk(
      SAMPLE_DOC_PATH,
      ctx.contentDir,
      ctx.contentDir,
    );
    expect(skeleton.docPath).toBe(SAMPLE_DOC_PATH);

    const flat = skeleton.flat;
    expect(flat.length).toBeGreaterThanOrEqual(3);

    // Should contain root, Overview, and Timeline entries
    const headings = flat.map((e) => e.heading);
    expect(headings).toContain("Overview");
    expect(headings).toContain("Timeline");
  });

  it("skeleton.flat returns all leaf entries in document order", async () => {
    const skeleton = await DocumentSkeleton.fromDisk(
      SAMPLE_DOC_PATH,
      ctx.contentDir,
      ctx.contentDir,
    );
    const flat = skeleton.flat;

    // Sample doc has root + Overview + Timeline = 3 entries
    expect(flat).toHaveLength(3);

    // Check headings in order: root (""), Overview, Timeline
    expect(flat[0].heading).toBe("");
    expect(flat[1].heading).toBe("Overview");
    expect(flat[2].heading).toBe("Timeline");
  });

  it("createEmpty creates valid skeleton with root section", () => {
    const skeleton = DocumentSkeleton.createEmpty("new-doc.md", ctx.contentDir);
    expect(skeleton.docPath).toBe("new-doc.md");
    expect(skeleton.dirty).toBe(true);

    const flat = skeleton.flat;
    expect(flat).toHaveLength(1);
    expect(flat[0].heading).toBe("");
    expect(flat[0].level).toBe(0);
    expect(flat[0].sectionFile).toBeTruthy();
  });

  it("skeleton.persist writes skeleton to disk and can be re-read", async () => {
    const skeleton = DocumentSkeleton.createEmpty("persist-test.md", ctx.contentDir);
    await skeleton.persist();

    const reloaded = await DocumentSkeleton.fromDisk(
      "persist-test.md",
      ctx.contentDir,
      ctx.contentDir,
    );
    const flat = reloaded.flat;
    expect(flat).toHaveLength(1);
    expect(flat[0].heading).toBe("");
    expect(flat[0].level).toBe(0);
  });
});

// ─── Phase 1: resolve() and resolveByFileId() tests ─────────────

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

  // Top-level skeleton: root + Introduction + Details
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

  // details.md is a sub-skeleton file (contains section markers)
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

describe("DocumentSkeleton.resolve() — flat document (no sub-skeletons)", () => {
  let ctx: TempDataRootContext;
  let skeleton: DocumentSkeleton;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    skeleton = await DocumentSkeleton.fromDisk(SAMPLE_DOC_PATH, ctx.contentDir, ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("resolve(['Overview']) returns correct absolutePath, level, heading, isSubSkeleton=false", () => {
    const entry = skeleton.resolve(["Overview"]);
    expect(entry.heading).toBe("Overview");
    expect(entry.level).toBe(2);
    expect(entry.sectionFile).toBe("overview.md");
    expect(entry.absolutePath).toContain("overview.md");
    expect(entry.absolutePath).toContain(".sections");
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.headingPath).toEqual(["Overview"]);
  });

  it("resolve(['Timeline']) returns correct entry", () => {
    const entry = skeleton.resolve(["Timeline"]);
    expect(entry.heading).toBe("Timeline");
    expect(entry.level).toBe(2);
    expect(entry.isSubSkeleton).toBe(false);
  });

  it("resolve([]) returns root section with isSubSkeleton=false", () => {
    const entry = skeleton.resolve([]);
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.headingPath).toEqual([]);
  });

  it("resolve() throws for nonexistent heading", () => {
    expect(() => skeleton.resolve(["Nonexistent"])).toThrow(/not found/);
  });
});

describe("DocumentSkeleton.resolve() — nested document (sub-skeletons)", () => {
  let ctx: TempDataRootContext;
  let skeleton: DocumentSkeleton;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    skeleton = await DocumentSkeleton.fromDisk(NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("flat view includes all 6 entries (root, intro, details-subskel, details-root, sub_a, sub_b)", () => {
    const flat = skeleton.flat;
    expect(flat).toHaveLength(6);
    const headings = flat.map(e => e.heading);
    expect(headings).toEqual(["", "Introduction", "Details", "", "Sub-Detail A", "Sub-Detail B"]);
  });

  it("resolve(['Details']) follows through to root child body file (fixed behavior)", () => {
    const entry = skeleton.resolve(["Details"]);
    expect(entry.heading).toBe("Details");
    expect(entry.level).toBe(2);
    expect(entry.isSubSkeleton).toBe(false);
    // absolutePath now points to the root child body file, not the sub-skeleton
    expect(entry.absolutePath).toContain("_details_root.md");
    expect(entry.absolutePath).toContain("details.md.sections");
    expect(entry.sectionFile).toBe("_details_root.md");
    expect(entry.headingPath).toEqual(["Details"]);
  });

  it("resolve(['Introduction']) returns body file with isSubSkeleton=false (correct)", () => {
    const entry = skeleton.resolve(["Introduction"]);
    expect(entry.heading).toBe("Introduction");
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("intro.md");
  });

  it("resolve(['Details', 'Sub-Detail A']) returns child body with isSubSkeleton=false", () => {
    const entry = skeleton.resolve(["Details", "Sub-Detail A"]);
    expect(entry.heading).toBe("Sub-Detail A");
    expect(entry.level).toBe(3);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("sub_a.md");
    expect(entry.headingPath).toEqual(["Details", "Sub-Detail A"]);
  });

  it("resolve([]) returns root section — root has no children so isSubSkeleton=false", () => {
    const entry = skeleton.resolve([]);
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.isSubSkeleton).toBe(false);
  });
});

describe("DocumentSkeleton.resolve([]) — root with children", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("resolve([]) follows through to root child body file when root has children (fixed)", async () => {
    // Create a document where the root node itself has children
    const docPath = "test/root-with-children.md";
    const contentRoot = ctx.contentDir;
    const skeletonPath = join(contentRoot, docPath);
    const sectionsDir = `${skeletonPath}.sections`;
    await mkdir(sectionsDir, { recursive: true });

    // Root is a sub-skeleton: root file contains section markers
    const topSkeleton = "{{section: _root.md}}\n";
    await writeFile(skeletonPath, topSkeleton, "utf8");

    // _root.md is a sub-skeleton file with children
    const rootSubSkeleton = [
      "{{section: _root_body.md}}",
      "",
      "## Child Heading",
      "{{section: child.md}}",
      "",
    ].join("\n");
    const rootSectionsDir = join(sectionsDir, "_root.md.sections");
    await mkdir(rootSectionsDir, { recursive: true });
    await writeFile(join(sectionsDir, "_root.md"), rootSubSkeleton, "utf8");
    await writeFile(join(rootSectionsDir, "_root_body.md"), "Root body.\n", "utf8");
    await writeFile(join(rootSectionsDir, "child.md"), "Child body.\n", "utf8");

    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec(
      ["-c", "user.name=Test", "-c", "user.email=test@test.local",
       "commit", "-m", "root-with-children doc", "--allow-empty"],
      ctx.rootDir,
    );

    const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
    const root = skeleton.resolve([]);
    expect(root.heading).toBe("");
    expect(root.level).toBe(0);
    expect(root.isSubSkeleton).toBe(false);
    // Should point to the root child body file, not the sub-skeleton
    expect(root.absolutePath).toContain("_root_body.md");
    expect(root.sectionFile).toBe("_root_body.md");
  });
});

describe("DocumentSkeleton.resolveByFileId() — nested document", () => {
  let ctx: TempDataRootContext;
  let skeleton: DocumentSkeleton;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    skeleton = await DocumentSkeleton.fromDisk(NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("resolveByFileId for sub-skeleton file returns isSubSkeleton=true (broken: callers get skeleton path)", () => {
    const entry = skeleton.resolveByFileId("details.md");
    expect(entry.heading).toBe("Details");
    expect(entry.isSubSkeleton).toBe(true);
    expect(entry.absolutePath).toContain("details.md");
    // This is the sub-skeleton file, not the body file — callers that expect
    // body content will get skeleton markup instead.
  });

  it("resolveByFileId for root child within sub-skeleton returns the body file path", () => {
    const entry = skeleton.resolveByFileId("_details_root.md");
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("_details_root.md");
    expect(entry.absolutePath).toContain("details.md.sections");
  });

  it("resolveByFileId for a leaf child returns body file with isSubSkeleton=false", () => {
    const entry = skeleton.resolveByFileId("sub_a.md");
    expect(entry.heading).toBe("Sub-Detail A");
    expect(entry.level).toBe(3);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("sub_a.md");
  });

  it("resolveByFileId('__root__') returns the document root section", () => {
    const entry = skeleton.resolveByFileId("__root__");
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.headingPath).toEqual([]);
  });

  it("resolveByFileId throws for nonexistent file ID", () => {
    expect(() => skeleton.resolveByFileId("nonexistent.md")).toThrow(/not found/);
  });
});

describe("DocumentSkeleton.resolveByFileId('__root__') — root with children", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("resolveByFileId('__root__') when root has no children returns isSubSkeleton=false", async () => {
    // The nested doc's root has no children
    const skeleton = await DocumentSkeleton.fromDisk(NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir);
    const entry = skeleton.resolveByFileId("__root__");
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.isSubSkeleton).toBe(false);
  });

  it("resolveByFileId('__root__') when root has children follows through to body (fixed)", async () => {
    const docPath = "test/root-children-fileid.md";
    const skeletonPath = join(ctx.contentDir, docPath);
    const sectionsDir = `${skeletonPath}.sections`;
    await mkdir(sectionsDir, { recursive: true });

    await writeFile(skeletonPath, "{{section: _root.md}}\n", "utf8");

    const rootSubSkeleton = [
      "{{section: _body.md}}",
      "",
      "## Sub",
      "{{section: sub.md}}",
      "",
    ].join("\n");
    const rootSectionsDir = join(sectionsDir, "_root.md.sections");
    await mkdir(rootSectionsDir, { recursive: true });
    await writeFile(join(sectionsDir, "_root.md"), rootSubSkeleton, "utf8");
    await writeFile(join(rootSectionsDir, "_body.md"), "body.\n", "utf8");
    await writeFile(join(rootSectionsDir, "sub.md"), "sub.\n", "utf8");

    await gitExec(["add", "content/"], ctx.rootDir);
    await gitExec(
      ["-c", "user.name=Test", "-c", "user.email=test@test.local",
       "commit", "-m", "root-children-fileid doc", "--allow-empty"],
      ctx.rootDir,
    );

    const skeleton = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    const entry = skeleton.resolveByFileId("__root__");
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("_body.md");
    expect(entry.sectionFile).toBe("_body.md");
  });
});
