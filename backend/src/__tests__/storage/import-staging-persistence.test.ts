/**
 * Import staging persistence across server restart / service reinitialization
 * (spec 07 §Import; import-staging.ts: "All state is on disk … Survives server
 * restarts with no reconstruction needed").
 *
 * The restart/reload seam here is module RE-INITIALIZATION: the staging module
 * holds NO in-memory map, so a freshly-loaded module instance must reconstruct
 * the staged import purely from disk. This is real persistence, not faked process
 * memory — `vi.resetModules()` + a fresh dynamic import simulates the new process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createImport, writeUploadedFiles } from "../../api/application/imports.js";

const DOC = ["## Alpha", "", "Alpha body.", "", "## Beta", "", "Beta body.", ""].join("\n");

describe("import staging persistence across reinitialization (spec 07)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    vi.resetModules();
    await ctx.cleanup();
  });

  it("a freshly reinitialized staging module reconstructs the staged import from disk", async () => {
    const { importId } = await createImport();
    await writeUploadedFiles(importId, [
      { name: "guide.md", content: DOC },
      { name: "sub/nested.md", content: "## Only\n\nNested body.\n" },
    ]);

    // Simulate a process restart: drop all loaded modules and re-import the
    // staging module fresh. KS_DATA_ROOT (process.env) persists, so the fresh
    // module resolves the same on-disk staging root.
    vi.resetModules();
    const fresh = await import("../../storage/import-staging.js");

    // The folder is rediscovered purely from disk.
    const folders = await fresh.listStagingFolders();
    expect(folders.map((f) => f.importId)).toContain(importId);

    // Its files (and detected structure) survive the restart.
    const scan = await fresh.scanStagingFolder(importId);
    const byPath = new Map(scan.map((f) => [f.relativePath, f]));
    expect(byPath.get("guide.md")?.sectionCount).toBe(2);
    expect(byPath.get("sub/nested.md")?.sectionCount).toBe(1);

    // And the raw staged content is readable for a subsequent commit.
    const staged = await fresh.readStagingFiles(importId);
    expect(staged.map((f) => f.docPath).sort()).toEqual(["guide.md", "sub/nested.md"]);
  });
});
