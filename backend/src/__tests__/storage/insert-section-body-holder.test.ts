import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DocumentSkeleton, DocumentSkeletonInternal, type FlatEntry } from "../../storage/document-skeleton.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

describe("insertSectionUnder body holder bug", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns body holder in added array when inserting child under a leaf", async () => {
    const skeleton = DocumentSkeletonInternal.inMemoryEmpty("body-holder-test.md", ctx.contentDir);
    await skeleton.persistInternal();

    // Insert a root-level section "Parent" (level 1) — this is a leaf
    await skeleton.insertSectionUnder([], { heading: "Parent", level: 1, body: "" });

    // Now insert a child under "Parent" — this should turn Parent into a sub-skeleton
    // and create a body holder for it
    const added: FlatEntry[] = await skeleton.insertSectionUnder(
      ["Parent"],
      { heading: "Child", level: 2, body: "" },
    );

    // (a) added should contain at least 2 entries: the child + the body holder
    expect(added.length).toBeGreaterThanOrEqual(2);

    // (b) added should contain a body holder entry (heading === "", level === 0)
    const bodyHolder = added.find(e => e.heading === "" && e.level === 0);
    expect(bodyHolder).toBeDefined();

    // (c) that body holder should NOT be a sub-skeleton
    expect(bodyHolder!.isSubSkeleton).toBe(false);

    // (d) its absolutePath should be inside the parent's .sections/ directory
    expect(bodyHolder!.absolutePath).toContain(".sections/");
  });

  it("readAllSections succeeds after inserting child under a leaf", async () => {
    const docPath = "read-all-test.md";
    const skeleton = DocumentSkeletonInternal.inMemoryEmpty(docPath, ctx.contentDir);
    await skeleton.persistInternal();

    // Insert Parent leaf and write its body file
    const parentAdded = await skeleton.insertSectionUnder([], { heading: "Parent", level: 1, body: "" });
    for (const entry of parentAdded) {
      if (!entry.isSubSkeleton) {
        await mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await writeFile(entry.absolutePath, "Parent body content", "utf8");
      }
    }

    // Insert Child under Parent — write body files for everything returned in added
    const childAdded = await skeleton.insertSectionUnder(
      ["Parent"],
      { heading: "Child", level: 2, body: "" },
    );
    for (const entry of childAdded) {
      if (!entry.isSubSkeleton) {
        await mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await writeFile(entry.absolutePath, "", "utf8");
      }
    }

    // readAllSections should NOT throw DocumentAssemblyError
    const contentLayer = new ContentLayer(ctx.contentDir);
    const allSections = await contentLayer.readAllSections(docPath);

    // Should contain keys for both the body holder (key "Parent") and the child (key "Parent>>Child")
    expect(allSections.has("Parent")).toBe(true);
    expect(allSections.has("Parent>>Child")).toBe(true);
  });

  it("skeleton/disk consistency after insert-under-leaf", async () => {
    const docPath = "disk-consistency-test.md";
    const skeleton = DocumentSkeletonInternal.inMemoryEmpty(docPath, ctx.contentDir);
    await skeleton.persistInternal();

    // Insert leaf "A"
    const aAdded = await skeleton.insertSectionUnder([], { heading: "A", level: 1, body: "" });
    for (const entry of aAdded) {
      if (!entry.isSubSkeleton) {
        await mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await writeFile(entry.absolutePath, "A body", "utf8");
      }
    }

    // Insert child "B" under "A" — write body files for returned added entries
    const bAdded = await skeleton.insertSectionUnder(["A"], { heading: "B", level: 2, body: "" });
    for (const entry of bAdded) {
      if (!entry.isSubSkeleton) {
        await mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await writeFile(entry.absolutePath, "", "utf8");
      }
    }

    // Reload skeleton from disk
    const reloaded = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);

    // Walk all entries via forEachSection — every non-sub-skeleton entry must have a file on disk
    const missing: string[] = [];
    const checkPromises: Promise<void>[] = [];
    reloaded.forEachSection((_heading, _level, _sectionFile, _headingPath, absolutePath) => {
      checkPromises.push(
        access(absolutePath).catch(() => { missing.push(absolutePath); }),
      );
    });
    await Promise.all(checkPromises);

    expect(missing).toEqual([]);
  });

  it("parity between splitSection (replace) and insertSectionUnder body holder handling", async () => {
    // Path A: use replace() to split a flat section into parent + child
    const skeletonA = DocumentSkeletonInternal.inMemoryEmpty("parity-a.md", ctx.contentDir);
    await skeletonA.persistInternal();
    await skeletonA.insertSectionUnder([], { heading: "Parent", level: 1, body: "" });
    const resultA = await skeletonA.replace(
      ["Parent"],
      [
        { heading: "Parent", level: 1, body: "parent body" },
        { heading: "Child", level: 2, body: "child body" },
      ],
    );
    const bodyHoldersA = resultA.added.filter(e => e.heading === "" && e.level === 0);

    // Path B: use insertSectionUnder to add a child under a leaf
    const skeletonB = DocumentSkeletonInternal.inMemoryEmpty("parity-b.md", ctx.contentDir);
    await skeletonB.persistInternal();
    await skeletonB.insertSectionUnder([], { heading: "Parent", level: 1, body: "" });
    const addedB = await skeletonB.insertSectionUnder(
      ["Parent"],
      { heading: "Child", level: 2, body: "" },
    );
    const bodyHoldersB = addedB.filter(e => e.heading === "" && e.level === 0);

    // Both paths should produce exactly 1 body holder entry
    expect(bodyHoldersA).toHaveLength(1);
    expect(bodyHoldersB).toHaveLength(1);
  });

  it("parent body content preserved when leaf becomes sub-skeleton", async () => {
    const docPath = "preserve-content-test.md";
    const skeleton = DocumentSkeletonInternal.inMemoryEmpty(docPath, ctx.contentDir);
    await skeleton.persistInternal();

    // Insert leaf "Parent" and write body content to it
    const parentAdded = await skeleton.insertSectionUnder([], { heading: "Parent", level: 1, body: "" });
    for (const entry of parentAdded) {
      if (!entry.isSubSkeleton) {
        await mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await writeFile(entry.absolutePath, "Important content", "utf8");
      }
    }

    // Insert child "Child" under "Parent" — write body files for the child only
    const childAdded = await skeleton.insertSectionUnder(
      ["Parent"],
      { heading: "Child", level: 2, body: "" },
    );
    for (const entry of childAdded) {
      // Only write empty body for the child, not the body holder (which should
      // have been populated by insertSectionUnder with the parent's original content)
      if (!entry.isSubSkeleton && !(entry.heading === "" && entry.level === 0)) {
        await mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await writeFile(entry.absolutePath, "", "utf8");
      }
    }

    // Find the body holder (level === 0, heading === "") in the reloaded skeleton
    const reloaded = await DocumentSkeleton.fromDisk(docPath, ctx.contentDir, ctx.contentDir);
    let bodyHolderPath: string | null = null;
    reloaded.forEachSection((heading, level, _sectionFile, _headingPath, absolutePath) => {
      if (heading === "" && level === 0) {
        bodyHolderPath = absolutePath;
      }
    });

    expect(bodyHolderPath).not.toBeNull();

    // The body holder should contain "Important content", not ""
    const content = await readFile(bodyHolderPath!, "utf8");
    expect(content).toBe("Important content");
  });
});
