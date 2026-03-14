import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readSection, SectionNotFoundError } from "../../storage/section-reader.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";

describe("section-reader", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("readSection returns content for Overview heading", async () => {
    const content = await readSection(SAMPLE_DOC_PATH, ["Overview"]);
    expect(content).toBe(SAMPLE_SECTIONS.overview);
  });

  it("readSection returns content for Timeline heading", async () => {
    const content = await readSection(SAMPLE_DOC_PATH, ["Timeline"]);
    expect(content).toBe(SAMPLE_SECTIONS.timeline);
  });

  it("readSection returns a string", async () => {
    const content = await readSection(SAMPLE_DOC_PATH, ["Overview"]);
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });

  it("readSection throws for non-existent heading path", async () => {
    await expect(
      readSection(SAMPLE_DOC_PATH, ["Nonexistent"]),
    ).rejects.toThrow();
  });

  it("readSection throws for non-existent document", async () => {
    await expect(
      readSection("nonexistent.md", ["Overview"]),
    ).rejects.toThrow();
  });
});
