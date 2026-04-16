import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { DocumentSkeleton, type FlatEntry } from "../../storage/document-skeleton.js";
import { parseDocumentMarkdown } from "../../storage/markdown-sections.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

const DOC = "test/fresh.md";

function collectFlat(skeleton: DocumentSkeleton): FlatEntry[] {
  const entries: FlatEntry[] = [];
  skeleton.forEachNode((heading, level, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
    entries.push({ heading, level, sectionFile, headingPath: [...headingPath], absolutePath, isSubSkeleton });
  });
  return entries;
}

describe("writeFreshDocumentFromParsedMarkdown", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function callPrivate(layer: OverlayContentLayer, docPath: string, markdown: string): Promise<void> {
    const parsed = parseDocumentMarkdown(markdown);
    await (layer as unknown as Record<string, (...args: unknown[]) => Promise<void>>)
      .writeFreshDocumentFromParsedMarkdown(docPath, parsed);
  }

  async function createEmptyDoc(layer: OverlayContentLayer, docPath: string): Promise<void> {
    await layer.createDocument(docPath);
  }

  it("BFH-only parsed → BFH-only skeleton with one root and one body file", async () => {
    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await createEmptyDoc(layer, DOC);
    await callPrivate(layer, DOC, "Hello world.\n");

    const skeleton = await DocumentSkeleton.fromDisk(DOC, ctx.contentDir, ctx.contentDir);
    const flat = collectFlat(skeleton);
    const contentEntries = flat.filter((e) => !e.isSubSkeleton);
    expect(contentEntries).toHaveLength(1);
    expect(contentEntries[0].heading).toBe("");
    expect(contentEntries[0].level).toBe(0);
    expect(contentEntries[0].headingPath).toEqual([]);
  });

  it("multi-headed parsed → skeleton mirrors heading structure (root + N siblings)", async () => {
    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await createEmptyDoc(layer, DOC);
    const markdown = [
      "Preamble.",
      "",
      "## Alpha",
      "",
      "Alpha body.",
      "",
      "## Beta",
      "",
      "Beta body.",
    ].join("\n");
    await callPrivate(layer, DOC, markdown);

    const skeleton = await DocumentSkeleton.fromDisk(DOC, ctx.contentDir, ctx.contentDir);
    const flat = collectFlat(skeleton);
    const contentEntries = flat.filter((e) => !e.isSubSkeleton);
    expect(contentEntries.length).toBeGreaterThanOrEqual(3);
    const headings = contentEntries.map((e) => e.heading);
    expect(headings).toContain("");
    expect(headings).toContain("Alpha");
    expect(headings).toContain("Beta");
  });

  it("nested headings → sub-skeleton created via body-holder helper", async () => {
    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await createEmptyDoc(layer, DOC);
    const markdown = [
      "## A",
      "",
      "A body.",
      "",
      "### A.1",
      "",
      "A.1 body.",
    ].join("\n");
    await callPrivate(layer, DOC, markdown);

    const skeleton = await DocumentSkeleton.fromDisk(DOC, ctx.contentDir, ctx.contentDir);
    const flat = collectFlat(skeleton);
    const subSkeletons = flat.filter((e) => e.isSubSkeleton);
    expect(subSkeletons.length).toBeGreaterThanOrEqual(1);
    const contentEntries = flat.filter((e) => !e.isSubSkeleton);
    const headingPaths = contentEntries.map((e) => e.headingPath);
    expect(headingPaths).toContainEqual(["A"]);
    expect(headingPaths).toContainEqual(["A", "A.1"]);
  });

  it("precondition: doc with roots → throws with descriptive message", async () => {
    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await createEmptyDoc(layer, DOC);
    await callPrivate(layer, DOC, "# Existing\n\nSome content.\n");

    await expect(callPrivate(layer, DOC, "# New\n\nNew content.\n"))
      .rejects.toThrow(/precondition violated/);
  });

  it("precondition: overlay .sections/ dir exists → throws with descriptive message", async () => {
    const layer = new OverlayContentLayer(ctx.contentDir, ctx.contentDir);
    await createEmptyDoc(layer, DOC);
    const skeletonPath = join(ctx.contentDir, DOC);
    await mkdir(`${skeletonPath}.sections`, { recursive: true });
    await writeFile(join(`${skeletonPath}.sections`, "stale.md"), "stale", "utf8");

    await expect(callPrivate(layer, DOC, "Hello.\n"))
      .rejects.toThrow(/precondition violated/);
  });
});
