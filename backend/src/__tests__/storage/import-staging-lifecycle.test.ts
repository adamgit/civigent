/**
 * Import staging upload/preview lifecycle (spec 07 §Import).
 *
 * Uploaded files are written under `import-staging/{uuid}/`, the preview (scan)
 * reports each document path, its section count, and detected structure, and
 * separate imports are isolated on disk. Drives the real staging path — does NOT
 * bypass staging with in-memory import input.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createImport,
  writeUploadedFiles,
  scanImport,
  importStagingPath,
} from "../../api/application/imports.js";
import { getImportStagingRoot } from "../../storage/data-root.js";
import { FolderPath } from "../../types/shared.js";

const DOC = ["# Title", "", "Preamble.", "", "## Alpha", "", "Alpha body.", "", "## Beta", "", "Beta body.", ""].join("\n");
const NESTED = ["## Only", "", "Nested body.", ""].join("\n");

describe("import staging upload/preview lifecycle (spec 07)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("writes uploaded files under import-staging/{uuid}/ and previews structure", async () => {
    const { importId, stagingPath } = await createImport(FolderPath.root);
    // Staging folder is under the data root's import-staging/{uuid}.
    expect(stagingPath).toBe(join(getImportStagingRoot(), importId));
    expect(stagingPath.startsWith(join(ctx.rootDir, "import-staging"))).toBe(true);

    const count = await writeUploadedFiles(importId, [
      { name: "guide.md", content: DOC },
      { name: "sub/nested.md", content: NESTED },
    ]);
    expect(count).toBe(2);

    // Staged user files live under the record's files/ root (preserving subfolder),
    // beside meta.json which carries the destination folder + creation time.
    expect(await readFile(join(stagingPath, "files", "guide.md"), "utf8")).toBe(DOC);
    expect((await stat(join(stagingPath, "files", "sub", "nested.md"))).isFile()).toBe(true);
    const meta = JSON.parse(await readFile(join(stagingPath, "meta.json"), "utf8"));
    expect(meta.target_folder).toBe("/");
    expect(typeof meta.created_at).toBe("string");

    // Preview returns document paths + section counts + detected structure.
    const preview = await scanImport(importId);
    expect(preview.import_id).toBe(importId);
    const byPath = new Map(preview.files.map((f) => [f.path, f]));
    const guide = byPath.get("guide.md");
    expect(guide).toBeDefined();
    expect(guide!.is_markdown).toBe(true);
    expect(guide!.is_internal_artifact).toBe(false);
    expect(guide!.rejection_reason).toBeNull();
    // Detected structure: before-first-heading + Alpha + Beta = 3 sections.
    expect(guide!.section_count).toBe(3);
    const nested = byPath.get("sub/nested.md");
    expect(nested?.section_count).toBe(1);
  });

  it("isolates staged uploads across separate imports", async () => {
    const a = await createImport(FolderPath.root);
    const b = await createImport(FolderPath.root);
    expect(a.importId).not.toBe(b.importId);

    await writeUploadedFiles(a.importId, [{ name: "a.md", content: DOC }]);
    await writeUploadedFiles(b.importId, [{ name: "b.md", content: NESTED }]);

    const scanA = await scanImport(a.importId);
    const scanB = await scanImport(b.importId);
    expect(scanA.files.map((f) => f.path)).toEqual(["a.md"]);
    expect(scanB.files.map((f) => f.path)).toEqual(["b.md"]);
    // Distinct on-disk folders.
    expect(importStagingPath(a.importId)).not.toBe(importStagingPath(b.importId));
  });

  it("flags a non-markdown upload attempt rather than staging it", async () => {
    const { importId } = await createImport(FolderPath.root);
    await expect(
      writeUploadedFiles(importId, [{ name: "notes.txt", content: "nope" }]),
    ).rejects.toThrow(/only \.md/i);
  });
});
