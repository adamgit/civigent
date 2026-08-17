import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";
import { getImportStagingRoot } from "../../storage/import-staging.js";

async function buildStoredZip(entries: Array<{ name: string; content: string }>): Promise<Buffer> {
  const zip = new ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.content, "utf8"), entry.name, { compress: false });
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function patchEntryName(zip: Buffer, placeholder: string, replacement: string): Buffer {
  if (placeholder.length !== replacement.length) {
    throw new Error("placeholder and replacement must be the same byte length");
  }
  const out = Buffer.from(zip);
  const needle = Buffer.from(placeholder, "utf8");
  let patchedCount = 0;
  let index = out.indexOf(needle);
  while (index !== -1) {
    Buffer.from(replacement, "utf8").copy(out, index);
    patchedCount++;
    index = out.indexOf(needle, index + 1);
  }
  if (patchedCount < 2) {
    throw new Error(`expected placeholder in local header and central directory, patched ${patchedCount}`);
  }
  return out;
}

async function listAllFilesUnder(dir: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (relative: string) => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(relPath);
      } else {
        results.push(relPath);
      }
    }
  };
  await walk("");
  return results.sort();
}

describe("zip-slip entries are rejected wholesale at upload", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("refuses a zip containing traversal and absolute entry paths, writing nothing", async () => {
    const created = await request(ctx.app)
      .post("/api/imports")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/json")
      .send({ target_folder: "/" });
    expect(created.status).toBe(201);
    const importId = created.body.import_id as string;

    const benign = await buildStoredZip([
      { name: "ok.md", content: "# Ok\n\nSafe body.\n" },
      { name: "ZZ/escape.md", content: "# Slipped\n\nTraversal payload.\n" },
      { name: "Aabs.md", content: "# Rooted\n\nRooted payload.\n" },
    ]);
    const malicious = patchEntryName(
      patchEntryName(benign, "ZZ/escape.md", "../escape.md"),
      "Aabs.md",
      "/abs.md",
    );

    const uploaded = await request(ctx.app)
      .post(`/api/imports/${importId}/upload-zip`)
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/zip")
      .send(malicious);
    expect(uploaded.status).toBe(400);

    const stagingRoot = getImportStagingRoot();
    const writtenInsideImport = await listAllFilesUnder(join(stagingRoot, importId));
    expect(writtenInsideImport.filter((f) => f.endsWith(".md"))).toEqual([]);

    const writtenAtStagingRoot = await listAllFilesUnder(stagingRoot);
    expect(writtenAtStagingRoot).not.toContain("escape.md");
  });
});
