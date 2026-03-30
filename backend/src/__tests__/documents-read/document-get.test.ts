import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/documents/:doc_path", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns assembled markdown content with doc_path, content, head_sha, sections_meta", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(typeof res.body.content).toBe("string");
    expect(res.body.content).toContain(SAMPLE_SECTIONS.overview);
    expect(res.body.content).toContain(SAMPLE_SECTIONS.timeline);
    expect(res.body).toHaveProperty("head_sha");
    expect(res.body).toHaveProperty("sections_meta");
  });

  it("returns head_sha as a string", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(typeof res.body.head_sha).toBe("string");
    expect(res.body.head_sha.length).toBeGreaterThan(0);
  });

  it("returns sections_meta as an array", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections_meta)).toBe(true);
    expect(res.body.sections_meta.length).toBeGreaterThan(0);
  });

  it("returns 404 for non-existent document", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/nonexistent.md")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(404);
  });

  it("returns 404 for path traversal attempt", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/../../etc/passwd")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(404);
  });
});
