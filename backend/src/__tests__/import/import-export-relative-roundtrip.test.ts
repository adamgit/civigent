import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Response } from "superagent";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";

const OPS_DOCS: Array<{ docPath: string; markdown: string }> = [
  { docPath: "/ops/strategy.md", markdown: "# Strategy\n\nAlpha body.\n" },
  { docPath: "/ops/team/roles.md", markdown: "# Roles\n\nBeta body.\n" },
];

function binaryParser(res: Response, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;

function zipEntryNames(zip: Buffer): string[] {
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("zip end-of-central-directory record not found");
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let offset = zip.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];
  for (let n = 0; n < entryCount; n++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error("malformed central directory entry");
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

async function fetchExportZip(ctx: TestServerContext, query: string): Promise<Buffer> {
  const res = await request(ctx.app)
    .get(`/api/export?${query}`)
    .set("Authorization", ctx.humanToken)
    .buffer(true)
    .parse(binaryParser);
  expect(res.status).toBe(200);
  return res.body as Buffer;
}

async function readCanonical(ctx: TestServerContext, docPath: string) {
  return request(ctx.app).get(`/api/canonical${docPath}`).set("Authorization", ctx.humanToken);
}

describe("relative export → zip import round-trip (the batch law)", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    for (const doc of OPS_DOCS) {
      const res = await request(ctx.app)
        .put(`/api/workspace${doc.docPath}`)
        .set("Authorization", ctx.humanToken)
        .set("Content-Type", "application/json")
        .send({ markdown: doc.markdown });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("exports /ops with folder-relative entry paths and absolute layout on request", async () => {
    const relativeZip = await fetchExportZip(ctx, "path=%2Fops");
    expect(zipEntryNames(relativeZip).sort()).toEqual(["strategy.md", "team/roles.md"]);

    const absoluteZip = await fetchExportZip(ctx, "path=%2Fops&layout=absolute");
    expect(zipEntryNames(absoluteZip).sort()).toEqual(["ops/strategy.md", "ops/team/roles.md"]);
  });

  it("re-imports the exported zip under a new destination folder with identical content", async () => {
    const zip = await fetchExportZip(ctx, "path=%2Fops");

    const created = await request(ctx.app)
      .post("/api/imports")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/json")
      .send({ target_folder: "/ops2" });
    expect(created.status).toBe(201);
    const importId = created.body.import_id as string;

    const uploaded = await request(ctx.app)
      .post(`/api/imports/${importId}/upload-zip`)
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/zip")
      .send(zip);
    expect(uploaded.status).toBe(200);

    const detail = await request(ctx.app)
      .get(`/api/imports/${importId}`)
      .set("Authorization", ctx.humanToken);
    expect(detail.status).toBe(200);
    expect(detail.body.target_folder).toBe("/ops2");
    const stagedPaths = (detail.body.files as Array<{ path: string }>).map((f) => f.path).sort();
    expect(stagedPaths).toEqual(["strategy.md", "team/roles.md"]);

    const committed = await request(ctx.app)
      .post(`/api/imports/${importId}/commit`)
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/json")
      .send({ description: "Round-trip re-import of /ops into /ops2" });
    expect(committed.status).toBe(201);

    for (const doc of OPS_DOCS) {
      const sourceRead = await readCanonical(ctx, doc.docPath);
      expect(sourceRead.status).toBe(200);
      const destPath = doc.docPath.replace(/^\/ops\//, "/ops2/");
      const destRead = await readCanonical(ctx, destPath);
      expect(destRead.status).toBe(200);
      expect((destRead.body.content as string).trim()).toBe((sourceRead.body.content as string).trim());
    }

    const rootLeak = await readCanonical(ctx, "/strategy.md");
    expect(rootLeak.status).toBe(404);
  });
});
