import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listSkeletonEntriesAtRoot, resolveSkeletonPath } from "../../storage/document-skeleton.js";
import { ContentLayer, OverlayContentLayer } from "../../storage/content-layer.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

const DOC_PATH = "folder/sample.md";

async function writeSkeleton(root: string, docPath: string, body: string): Promise<void> {
  const skeletonPath = resolveSkeletonPath(docPath, root);
  await mkdir(join(skeletonPath, ".."), { recursive: true });
  await writeFile(skeletonPath, body, "utf8");
}

async function writeSectionsDir(root: string, docPath: string): Promise<string> {
  const skeletonPath = resolveSkeletonPath(docPath, root);
  const sectionsDir = `${skeletonPath}.sections`;
  await mkdir(sectionsDir, { recursive: true });
  return sectionsDir;
}

describe("listSkeletonEntriesAtRoot", () => {
  let ctx: TempDataRootContext;
  let canonicalRoot: string;
  let overlayRoot: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    canonicalRoot = join(ctx.rootDir, "canonical");
    overlayRoot = join(ctx.rootDir, "overlay");
    await mkdir(canonicalRoot, { recursive: true });
    await mkdir(overlayRoot, { recursive: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns null when the skeleton file does not exist at the given root", async () => {
    const result = await listSkeletonEntriesAtRoot(DOC_PATH, canonicalRoot);
    expect(result).toBeNull();
  });

  it("returns [] when the skeleton file exists but is empty", async () => {
    await writeSkeleton(canonicalRoot, DOC_PATH, "");
    const result = await listSkeletonEntriesAtRoot(DOC_PATH, canonicalRoot);
    expect(result).toEqual([]);
  });

  it("enumerates top-level entries in document order", async () => {
    const sectionsDir = await writeSectionsDir(canonicalRoot, DOC_PATH);
    await writeFile(join(sectionsDir, "sec_a.md"), "body a", "utf8");
    await writeFile(join(sectionsDir, "sec_b.md"), "body b", "utf8");
    await writeSkeleton(
      canonicalRoot,
      DOC_PATH,
      [
        "## Alpha",
        "{{section: sec_a.md}}",
        "## Beta",
        "{{section: sec_b.md}}",
      ].join("\n"),
    );

    const result = await listSkeletonEntriesAtRoot(DOC_PATH, canonicalRoot);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].heading).toBe("Alpha");
    expect(result![0].headingPath).toEqual(["Alpha"]);
    expect(result![0].sectionFile).toBe("sec_a.md");
    expect(result![0].isSubSkeleton).toBe(false);
    expect(result![1].heading).toBe("Beta");
    expect(result![1].headingPath).toEqual(["Beta"]);
    expect(result![1].isSubSkeleton).toBe(false);
  });

  it("recurses into sub-skeletons and flags parent isSubSkeleton=true", async () => {
    const sectionsDir = await writeSectionsDir(canonicalRoot, DOC_PATH);
    const subDir = join(sectionsDir, "sec_parent.md.sections");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "sec_child.md"), "child body", "utf8");

    await writeFile(
      join(sectionsDir, "sec_parent.md"),
      ["### Child", "{{section: sec_child.md}}"].join("\n"),
      "utf8",
    );
    await writeSkeleton(
      canonicalRoot,
      DOC_PATH,
      ["## Parent", "{{section: sec_parent.md}}"].join("\n"),
    );

    const result = await listSkeletonEntriesAtRoot(DOC_PATH, canonicalRoot);
    expect(result).not.toBeNull();
    const entries = result!;
    expect(entries).toHaveLength(2);
    expect(entries[0].heading).toBe("Parent");
    expect(entries[0].isSubSkeleton).toBe(true);
    expect(entries[0].headingPath).toEqual(["Parent"]);
    expect(entries[1].heading).toBe("Child");
    expect(entries[1].isSubSkeleton).toBe(false);
    expect(entries[1].headingPath).toEqual(["Parent", "Child"]);
  });
});

describe("ContentLayer.listCanonicalEntries", () => {
  let ctx: TempDataRootContext;
  let canonicalRoot: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    canonicalRoot = join(ctx.rootDir, "canonical");
    await mkdir(canonicalRoot, { recursive: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns canonical entries when the canonical skeleton exists", async () => {
    const sectionsDir = await writeSectionsDir(canonicalRoot, DOC_PATH);
    await writeFile(join(sectionsDir, "sec_a.md"), "body a", "utf8");
    await writeSkeleton(canonicalRoot, DOC_PATH, ["## Alpha", "{{section: sec_a.md}}"].join("\n"));

    const layer = new ContentLayer(canonicalRoot);
    const entries = await layer.listCanonicalEntries(DOC_PATH);
    expect(entries).toHaveLength(1);
    expect(entries[0].headingPath).toEqual(["Alpha"]);
    expect(entries[0].sectionFile).toBe("sec_a.md");
  });

  it("returns [] when no canonical skeleton exists (no throw)", async () => {
    const layer = new ContentLayer(canonicalRoot);
    const entries = await layer.listCanonicalEntries(DOC_PATH);
    expect(entries).toEqual([]);
  });
});

describe("OverlayContentLayer.listOverlayOnlyEntries", () => {
  let ctx: TempDataRootContext;
  let canonicalRoot: string;
  let overlayRoot: string;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    canonicalRoot = join(ctx.rootDir, "canonical");
    overlayRoot = join(ctx.rootDir, "overlay");
    await mkdir(canonicalRoot, { recursive: true });
    await mkdir(overlayRoot, { recursive: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("returns null when no overlay skeleton exists — even if canonical has one (no fallback)", async () => {
    const sectionsDir = await writeSectionsDir(canonicalRoot, DOC_PATH);
    await writeFile(join(sectionsDir, "sec_a.md"), "body a", "utf8");
    await writeSkeleton(canonicalRoot, DOC_PATH, ["## Alpha", "{{section: sec_a.md}}"].join("\n"));

    const layer = new OverlayContentLayer(overlayRoot, canonicalRoot);
    const entries = await layer.listOverlayOnlyEntries(DOC_PATH);
    expect(entries).toBeNull();
  });

  it("returns overlay entries when overlay skeleton exists, ignoring canonical", async () => {
    const canonicalSectionsDir = await writeSectionsDir(canonicalRoot, DOC_PATH);
    await writeFile(join(canonicalSectionsDir, "sec_old.md"), "old", "utf8");
    await writeSkeleton(canonicalRoot, DOC_PATH, ["## Old", "{{section: sec_old.md}}"].join("\n"));

    const overlaySectionsDir = await writeSectionsDir(overlayRoot, DOC_PATH);
    await writeFile(join(overlaySectionsDir, "sec_new.md"), "new", "utf8");
    await writeSkeleton(overlayRoot, DOC_PATH, ["## New", "{{section: sec_new.md}}"].join("\n"));

    const layer = new OverlayContentLayer(overlayRoot, canonicalRoot);
    const entries = await layer.listOverlayOnlyEntries(DOC_PATH);
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries![0].heading).toBe("New");
    expect(entries![0].sectionFile).toBe("sec_new.md");
  });

  it("returns [] when overlay skeleton exists but is empty (distinguished from null)", async () => {
    await writeSkeleton(overlayRoot, DOC_PATH, "");
    const layer = new OverlayContentLayer(overlayRoot, canonicalRoot);
    const entries = await layer.listOverlayOnlyEntries(DOC_PATH);
    expect(entries).toEqual([]);
  });
});
