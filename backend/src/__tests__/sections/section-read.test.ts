import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/sections", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns section content and head_sha for a valid section", async () => {
    const res = await request(ctx.app)
      .get("/api/sections")
      .query({ doc_path: SAMPLE_DOC_PATH, heading_path: "Overview" })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("content");
    expect(res.body.content).toContain(SAMPLE_SECTIONS.overview);
    expect(res.body).toHaveProperty("head_sha");
    expect(typeof res.body.head_sha).toBe("string");
  });

  it("returns 400 when doc_path is missing", async () => {
    const res = await request(ctx.app)
      .get("/api/sections")
      .query({ heading_path: "Overview" })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(400);
  });

  it("returns 400 when heading_path is missing", async () => {
    const res = await request(ctx.app)
      .get("/api/sections")
      .query({ doc_path: SAMPLE_DOC_PATH })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent section", async () => {
    const res = await request(ctx.app)
      .get("/api/sections")
      .query({ doc_path: SAMPLE_DOC_PATH, heading_path: "NonExistentSection" })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(404);
  });
});
