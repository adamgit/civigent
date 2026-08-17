import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readAssembledDocument, DocumentNotFoundError } from "../../storage/document-reader.js";
import { systemDocRead } from "../../auth/authorized-read.js";
import { systemAuthority } from "../../auth/system-authority.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import { DocPath } from "../../types/shared.js";

const readAssembledForTest = (docPath: string) =>
  readAssembledDocument(systemDocRead(systemAuthority("test read"), DocPath.parse(docPath)));

describe("document-reader", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    process.env.KS_SNAPSHOT_ENABLED = "false";
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    delete process.env.KS_SNAPSHOT_ENABLED;
    await ctx.cleanup();
  });

  it("readAssembledDocument concatenates all section content", async () => {
    const result = await readAssembledForTest(SAMPLE_DOC_PATH);
    expect(result).toContain(SAMPLE_SECTIONS.preamble.trim());
    expect(result).toContain(SAMPLE_SECTIONS.overview.trim());
    expect(result).toContain(SAMPLE_SECTIONS.timeline.trim());
  });

  it("readAssembledDocument returns a string", async () => {
    const result = await readAssembledForTest(SAMPLE_DOC_PATH);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("readAssembledDocument includes headings from skeleton", async () => {
    const result = await readAssembledForTest(SAMPLE_DOC_PATH);
    expect(result).toContain("## Overview");
    expect(result).toContain("## Timeline");
  });

  it("readAssembledDocument throws DocumentNotFoundError for missing doc", async () => {
    await expect(readAssembledForTest("/nonexistent/missing.md")).rejects.toThrow(
      DocumentNotFoundError,
    );
  });

  it("DocumentNotFoundError is an instance of Error", async () => {
    try {
      await readAssembledForTest("/nonexistent/missing.md");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(DocumentNotFoundError);
    }
  });
});
