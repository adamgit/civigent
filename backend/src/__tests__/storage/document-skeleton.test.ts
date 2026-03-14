import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

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
