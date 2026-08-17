import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";
import { getImportStagingRoot } from "../../storage/import-staging.js";

describe("corrupt import meta.json fails loudly, never silently defaults the destination", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("refuses to commit an import whose meta.json cannot be decoded", async () => {
    const created = await request(ctx.app)
      .post("/api/imports")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/json")
      .send({ target_folder: "/ops" });
    expect(created.status).toBe(201);
    const importId = created.body.import_id as string;

    const uploaded = await request(ctx.app)
      .post(`/api/imports/${importId}/upload`)
      .set("Authorization", ctx.humanToken)
      .attach("files", Buffer.from("# A\n\nBody of a.\n", "utf8"), "a.md");
    expect(uploaded.status).toBe(200);

    await writeFile(join(getImportStagingRoot(), importId, "meta.json"), "{ not json", "utf8");

    const committed = await request(ctx.app)
      .post(`/api/imports/${importId}/commit`)
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/json")
      .send({ description: "Commit against corrupt metadata" });
    expect(committed.status).toBeGreaterThanOrEqual(400);

    for (const landedPath of ["/a.md", "/ops/a.md"]) {
      const read = await request(ctx.app)
        .get(`/api/canonical${landedPath}`)
        .set("Authorization", ctx.humanToken);
      expect(read.status).toBe(404);
    }
  });
});
