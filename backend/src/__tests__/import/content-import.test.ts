import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { importContentFromDirectoryIfNeeded, importContent } from "../../storage/content-import.js";

describe("Content Import", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns skipped when source directory does not exist", async () => {
    const result = await importContentFromDirectoryIfNeeded(
      join(ctx.rootDir, "nonexistent-import"),
      join(ctx.rootDir, "content"),
    );
    expect(result.skipped).toBe(1);
  });

  it("imports markdown files from import directory into content structure", async () => {
    const importDir = join(ctx.rootDir, "import-src");
    await mkdir(importDir, { recursive: true });

    const sampleMd = "# Imported Doc\n\nThis is imported content.\n\n## Section A\n\nBody of section A.\n";
    await writeFile(join(importDir, "imported-doc.md"), sampleMd, "utf8");

    const result = await importContent(importDir, join(ctx.rootDir, "content"));
    expect(result.imported).toBeGreaterThanOrEqual(1);

    // Verify the content directory has the imported doc
    const contentDir = join(ctx.rootDir, "content");
    const files = await readdir(contentDir, { recursive: true });
    const fileNames = (files as string[]).map(String);
    expect(fileNames.some((f) => f.includes("imported-doc"))).toBe(true);
  });

  it("import is idempotent — second run imports zero new files", async () => {
    const importDir = join(ctx.rootDir, "import-src");
    const result = await importContent(importDir, join(ctx.rootDir, "content"));
    // Second import: file already exists, so it should skip
    expect(result.imported).toBe(0);
  });
});
