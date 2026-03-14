import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  readDocumentStructure,
  flattenStructureToHeadingPaths,
  flattenStructureWithLevels,
  resolveHeadingPath,
} from "../../storage/heading-resolver.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

describe("heading-resolver", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("readDocumentStructure returns heading tree for sample doc", async () => {
    const tree = await readDocumentStructure(SAMPLE_DOC_PATH);
    expect(Array.isArray(tree)).toBe(true);
    expect(tree.length).toBeGreaterThanOrEqual(1);

    const headings = tree.map((n) => n.heading);
    expect(headings).toContain("Overview");
    expect(headings).toContain("Timeline");
  });

  it("readDocumentStructure nodes have heading, level, and children", async () => {
    const tree = await readDocumentStructure(SAMPLE_DOC_PATH);

    for (const node of tree) {
      expect(typeof node.heading).toBe("string");
      expect(typeof node.level).toBe("number");
      expect(Array.isArray(node.children)).toBe(true);
    }
  });

  it("flattenStructureToHeadingPaths extracts ordered heading paths from structure tree", async () => {
    const tree = await readDocumentStructure(SAMPLE_DOC_PATH);
    const paths = flattenStructureToHeadingPaths(tree);

    expect(Array.isArray(paths)).toBe(true);
    expect(paths.length).toBeGreaterThanOrEqual(3);

    const hasRoot = paths.some((p) => p.length === 0);
    expect(hasRoot).toBe(true);

    const hasOverview = paths.some(
      (p) => p.length === 1 && p[0] === "Overview",
    );
    expect(hasOverview).toBe(true);

    const hasTimeline = paths.some(
      (p) => p.length === 1 && p[0] === "Timeline",
    );
    expect(hasTimeline).toBe(true);
  });

  it("flattenStructureWithLevels returns entries with heading, level, and headingPath", async () => {
    const tree = await readDocumentStructure(SAMPLE_DOC_PATH);
    const entries = flattenStructureWithLevels(tree);

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    for (const entry of entries) {
      expect(entry).toHaveProperty("heading");
      expect(entry).toHaveProperty("level");
      expect(entry).toHaveProperty("headingPath");
      expect(Array.isArray(entry.headingPath)).toBe(true);
    }
  });

  it("resolveHeadingPath returns a valid file path for Overview", async () => {
    const result = await resolveHeadingPath(SAMPLE_DOC_PATH, ["Overview"]);
    expect(typeof result).toBe("string");
    expect(result).toContain("overview");
  });

  it("resolveHeadingPath throws for non-existent heading", async () => {
    await expect(
      resolveHeadingPath(SAMPLE_DOC_PATH, ["NonExistent"]),
    ).rejects.toThrow();
  });
});
