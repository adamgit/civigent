import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DocumentSkeleton, DocumentSkeletonInternal, type FlatEntry, type SkeletonNode } from "../../storage/document-skeleton.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { gitExec } from "../../storage/git-repo.js";

function collectFlat(skeleton: DocumentSkeleton): FlatEntry[] {
  const entries: FlatEntry[] = [];
  skeleton.forEachNode((heading, level, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
    entries.push({ heading, level, sectionFile, headingPath: [...headingPath], absolutePath, isSubSkeleton });
  });
  return entries;
}

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

    const flat = collectFlat(skeleton);
    expect(flat.length).toBeGreaterThanOrEqual(3);

    // Should contain root, Overview, and Timeline entries
    const headings = flat.map((e) => e.heading);
    expect(headings).toContain("Overview");
    expect(headings).toContain("Timeline");
  });

  it("forEachSection returns all entries in document order", async () => {
    const skeleton = await DocumentSkeleton.fromDisk(
      SAMPLE_DOC_PATH,
      ctx.contentDir,
      ctx.contentDir,
    );
    const flat = collectFlat(skeleton);

    // Sample doc has root + Overview + Timeline = 3 entries
    expect(flat).toHaveLength(3);

    // Check headings in order: root (""), Overview, Timeline
    expect(flat[0].heading).toBe("");
    expect(flat[1].heading).toBe("Overview");
    expect(flat[2].heading).toBe("Timeline");
  });

  it("inMemoryWithRoot creates valid skeleton with root section", async () => {
    const skeleton = DocumentSkeletonInternal.inMemoryWithRoot("new-doc.md", ctx.contentDir);
    await skeleton.persistInternal();
    expect(skeleton.docPath).toBe("new-doc.md");

    const flat = collectFlat(skeleton);
    expect(flat).toHaveLength(1);
    expect(flat[0].heading).toBe("");
    expect(flat[0].level).toBe(0);
    expect(flat[0].sectionFile).toBeTruthy();
  });

  it("mutation auto-persists skeleton and can be re-read", async () => {
    const skeleton = DocumentSkeletonInternal.inMemoryWithRoot("persist-test.md", ctx.contentDir);
    await skeleton.persistInternal();
    await skeleton.insertSectionUnder([], { heading: "Persisted", level: 1, body: "" });

    const reloaded = await DocumentSkeleton.fromDisk(
      "persist-test.md",
      ctx.contentDir,
      ctx.contentDir,
    );
    const flat = collectFlat(reloaded);
    expect(flat).toHaveLength(2);
    expect(flat[0].heading).toBe("");
    expect(flat[1].heading).toBe("Persisted");
  });
});

// ─── Phase 1: expect() and expectByFileId() tests ─────────────

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

describe("DocumentSkeleton.expect() — flat document (no sub-skeletons)", () => {
  let ctx: TempDataRootContext;
  let skeleton: DocumentSkeleton;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
    skeleton = await DocumentSkeleton.fromDisk(SAMPLE_DOC_PATH, ctx.contentDir, ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("resolve(['Overview']) returns correct absolutePath, level, heading, isSubSkeleton=false", () => {
    const entry = skeleton.expect(["Overview"]);
    expect(entry.heading).toBe("Overview");
    expect(entry.level).toBe(2);
    expect(entry.sectionFile).toBe("overview.md");
    expect(entry.absolutePath).toContain("overview.md");
    expect(entry.absolutePath).toContain(".sections");
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.headingPath).toEqual(["Overview"]);
  });

  it("resolve(['Timeline']) returns correct entry", () => {
    const entry = skeleton.expect(["Timeline"]);
    expect(entry.heading).toBe("Timeline");
    expect(entry.level).toBe(2);
    expect(entry.isSubSkeleton).toBe(false);
  });

  it("resolve([]) returns root section with isSubSkeleton=false", () => {
    const entry = skeleton.expect([]);
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.headingPath).toEqual([]);
  });

  it("expect() throws for nonexistent heading", () => {
    expect(() => skeleton.expect(["Nonexistent"])).toThrow(/not found/);
  });
});

describe("DocumentSkeleton.expect() — nested document (sub-skeletons)", () => {
  let ctx: TempDataRootContext;
  let skeleton: DocumentSkeleton;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    skeleton = await DocumentSkeleton.fromDisk(NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("forEachSection includes all 6 entries (root, intro, details-subskel, details-root, sub_a, sub_b)", () => {
    const flat = collectFlat(skeleton);
    expect(flat).toHaveLength(6);
    const headings = flat.map(e => e.heading);
    expect(headings).toEqual(["", "Introduction", "Details", "", "Sub-Detail A", "Sub-Detail B"]);
  });

  it("resolve(['Details']) follows through to root child body file (fixed behavior)", () => {
    const entry = skeleton.expect(["Details"]);
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
    const entry = skeleton.expect(["Introduction"]);
    expect(entry.heading).toBe("Introduction");
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("intro.md");
  });

  it("resolve(['Details', 'Sub-Detail A']) returns child body with isSubSkeleton=false", () => {
    const entry = skeleton.expect(["Details", "Sub-Detail A"]);
    expect(entry.heading).toBe("Sub-Detail A");
    expect(entry.level).toBe(3);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("sub_a.md");
    expect(entry.headingPath).toEqual(["Details", "Sub-Detail A"]);
  });

  it("resolve([]) returns root section — root has no children so isSubSkeleton=false", () => {
    const entry = skeleton.expect([]);
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.isSubSkeleton).toBe(false);
  });
});

describe("DocumentSkeleton.expect([]) — root with children", () => {
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
    const root = skeleton.expect([]);
    expect(root.heading).toBe("");
    expect(root.level).toBe(0);
    expect(root.isSubSkeleton).toBe(false);
    // Should point to the root child body file, not the sub-skeleton
    expect(root.absolutePath).toContain("_root_body.md");
    expect(root.sectionFile).toBe("_root_body.md");
  });
});

describe("DocumentSkeleton.expectByFileId() — nested document", () => {
  let ctx: TempDataRootContext;
  let skeleton: DocumentSkeleton;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
    skeleton = await DocumentSkeleton.fromDisk(NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("resolveByFileId for sub-skeleton file returns isSubSkeleton=true (broken: callers get skeleton path)", () => {
    const entry = skeleton.expectByFileId("details.md");
    expect(entry.heading).toBe("Details");
    expect(entry.isSubSkeleton).toBe(true);
    expect(entry.absolutePath).toContain("details.md");
    // This is the sub-skeleton file, not the body file — callers that expect
    // body content will get skeleton markup instead.
  });

  it("resolveByFileId for root child within sub-skeleton returns the body file path", () => {
    const entry = skeleton.expectByFileId("_details_root.md");
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("_details_root.md");
    expect(entry.absolutePath).toContain("details.md.sections");
  });

  it("resolveByFileId for a leaf child returns body file with isSubSkeleton=false", () => {
    const entry = skeleton.expectByFileId("sub_a.md");
    expect(entry.heading).toBe("Sub-Detail A");
    expect(entry.level).toBe(3);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("sub_a.md");
  });

  it("resolveByFileId('__root__') returns the document root section", () => {
    const entry = skeleton.expectByFileId("__root__");
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.headingPath).toEqual([]);
  });

  it("resolveByFileId throws for nonexistent file ID", () => {
    expect(() => skeleton.expectByFileId("nonexistent.md")).toThrow(/not found/);
  });
});

describe("DocumentSkeleton.expectByFileId('__root__') — root with children", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createNestedDocument(ctx.rootDir);
  });

  afterAll(async () => { await ctx.cleanup(); });

  it("resolveByFileId('__root__') when root has no children returns isSubSkeleton=false", async () => {
    // The nested doc's root has no children
    const skeleton = await DocumentSkeleton.fromDisk(NESTED_DOC_PATH, ctx.contentDir, ctx.contentDir);
    const entry = skeleton.expectByFileId("__root__");
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
    const entry = skeleton.expectByFileId("__root__");
    expect(entry.heading).toBe("");
    expect(entry.level).toBe(0);
    expect(entry.isSubSkeleton).toBe(false);
    expect(entry.absolutePath).toContain("_body.md");
    expect(entry.sectionFile).toBe("_body.md");
  });
});

describe("DocumentSkeleton.fromNodes", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("produces a usable skeleton identical to one built by fromDisk", async () => {
    const diskSkeleton = await DocumentSkeleton.fromDisk(
      SAMPLE_DOC_PATH,
      ctx.contentDir,
      ctx.contentDir,
    );
    const diskEntries = collectFlat(diskSkeleton);

    // Build the same node tree manually
    const nodes = diskEntries
      .filter(e => !e.isSubSkeleton)
      .map(e => ({
        heading: e.heading,
        level: e.level,
        sectionFile: e.sectionFile,
        children: [] as import("../../storage/document-skeleton.js").SkeletonNode[],
      }));

    const nodeSkeleton = DocumentSkeletonInternal.fromNodes(SAMPLE_DOC_PATH, nodes, ctx.contentDir);
    const nodeEntries = collectFlat(nodeSkeleton);

    expect(nodeEntries.length).toBe(diskEntries.length);
    for (let i = 0; i < diskEntries.length; i++) {
      expect(nodeEntries[i].heading).toBe(diskEntries[i].heading);
      expect(nodeEntries[i].level).toBe(diskEntries[i].level);
      expect(nodeEntries[i].sectionFile).toBe(diskEntries[i].sectionFile);
    }

    // structure() should also match
    expect(nodeSkeleton.structure.length).toBe(diskSkeleton.structure.length);
  });
});

// ─── buildOverlaySkeleton regression tests ───────────────────────

describe("DocumentSkeleton.buildOverlaySkeleton — file-identity matching", () => {
  it("rename a heading mints a fresh file ID (no position-based reuse)", async () => {
    const ctx = await createTempDataRoot();
    try {
      const canonicalDir = join(ctx.rootDir, "canonical");
      const overlayDir = join(ctx.rootDir, "overlay");

      // Canonical: root, Section A (sec_a.md), Section B (sec_b.md)
      const canonicalNodes: SkeletonNode[] = [
        { heading: "", level: 0, sectionFile: "_root.md", children: [] },
        { heading: "Section A", level: 2, sectionFile: "sec_a.md", children: [] },
        { heading: "Section B", level: 2, sectionFile: "sec_b.md", children: [] },
      ];
      const canonical = DocumentSkeletonInternal.fromNodes("test/rename.md", canonicalNodes, canonicalDir);

      // Parsed: Section A renamed to "Renamed A", Section B unchanged
      const parsed = {
        sections: [
          { headingPath: [] as string[], heading: "", level: 0 },
          { headingPath: ["Renamed A"], heading: "Renamed A", level: 2 },
          { headingPath: ["Section B"], heading: "Section B", level: 2 },
        ],
      };

      const overlay = await canonical.buildOverlaySkeleton(parsed, overlayDir);

      const flat: Array<{ heading: string; sectionFile: string }> = [];
      overlay.forEachSection((heading, _level, sectionFile) => {
        flat.push({ heading, sectionFile });
      });

      // "Renamed A" must get a fresh ID — not sec_a.md
      expect(flat[1].heading).toBe("Renamed A");
      expect(flat[1].sectionFile).not.toBe("sec_a.md");

      // "Section B" must keep its canonical ID
      expect(flat[2].heading).toBe("Section B");
      expect(flat[2].sectionFile).toBe("sec_b.md");
    } finally {
      await ctx.cleanup();
    }
  });

  it("two sections share heading at different depths — no cross-path ID theft", async () => {
    const ctx = await createTempDataRoot();
    try {
      const canonicalDir = join(ctx.rootDir, "canonical");
      const overlayDir = join(ctx.rootDir, "overlay");

      // Canonical with sub-skeleton structure:
      //   root, Part 1 (sub-sk: p1.md), Part 1 root body (_p1_root.md),
      //   Part 1 > Summary (sum1.md), Part 2 (sub-sk: p2.md), Part 2 root body (_p2_root.md),
      //   Part 2 > Summary (sum2.md)
      const canonicalNodes: SkeletonNode[] = [
        { heading: "", level: 0, sectionFile: "_root.md", children: [] },
        {
          heading: "Part 1", level: 1, sectionFile: "p1.md",
          children: [
            { heading: "", level: 0, sectionFile: "_p1_root.md", children: [] },
            { heading: "Summary", level: 2, sectionFile: "sum1.md", children: [] },
          ],
        },
        {
          heading: "Part 2", level: 1, sectionFile: "p2.md",
          children: [
            { heading: "", level: 0, sectionFile: "_p2_root.md", children: [] },
            { heading: "Summary", level: 2, sectionFile: "sum2.md", children: [] },
          ],
        },
      ];
      const canonical = DocumentSkeletonInternal.fromNodes("test/cross-path.md", canonicalNodes, canonicalDir);

      // Parsed: only Part 2 > Summary is present (no Part 1 > Summary)
      // The buggy algorithm would grab sum1.md (first "Summary" in pool).
      // The correct algorithm matches by parent path, so it must pick sum2.md.
      const parsed = {
        sections: [
          { headingPath: [] as string[], heading: "", level: 0 },
          { headingPath: ["Part 1"], heading: "Part 1", level: 1 },
          { headingPath: ["Part 2"], heading: "Part 2", level: 1 },
          { headingPath: ["Part 2", "Summary"], heading: "Summary", level: 2 },
        ],
      };

      const overlay = await canonical.buildOverlaySkeleton(parsed, overlayDir);

      const flat: Array<{ heading: string; headingPath: string[]; sectionFile: string }> = [];
      overlay.forEachSection((heading, _level, sectionFile, headingPath) => {
        flat.push({ heading, headingPath: [...headingPath], sectionFile });
      });

      // The "Summary" section must match ["Part 2", "Summary"] → sum2.md, not sum1.md
      const summaryEntry = flat.find(e => e.heading === "Summary");
      expect(summaryEntry).toBeDefined();
      expect(summaryEntry!.sectionFile).toBe("sum2.md");
      expect(summaryEntry!.sectionFile).not.toBe("sum1.md");
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("DocumentSkeleton tombstone", () => {
  it("createTombstone writes a marker that shadows canonical reads", async () => {
    const ctx = await createTempDataRoot();
    try {
      // Write a real document in canonical
      await createSampleDocument(ctx.rootDir);

      // Create a tombstone in the overlay via the proper API
      const overlayDir = join(ctx.rootDir, "overlay", "content");
      await DocumentSkeleton.createTombstone(SAMPLE_DOC_PATH, overlayDir);

      // Re-read: overlay has the persisted tombstone marker, so fromDisk should
      // shadow canonical and expose the document as empty + tombstoned.
      const skeleton = await DocumentSkeleton.fromDisk(SAMPLE_DOC_PATH, overlayDir, ctx.contentDir);
      expect(skeleton.overlayPersisted).toBe(true);
      expect(skeleton.overlayTombstoned).toBe(true);
      expect(skeleton.isEmpty).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });
});
