import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/documents/:doc_path/sections", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns sections array", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(res.body.sections.length).toBeGreaterThan(0);
  });

  it("each section has heading_path, content, humanInvolvement_score, word_count", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    for (const section of res.body.sections) {
      expect(section).toHaveProperty("heading_path");
      expect(section).toHaveProperty("content");
      expect(section).toHaveProperty("humanInvolvement_score");
      expect(section).toHaveProperty("word_count");
    }
  });

  it("returns 200 with empty sections for non-existent document", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/nonexistent.md/sections")
      .set("Authorization", ctx.humanToken);

    // Non-existent docs return empty sections (skeleton returns empty nodes)
    expect(res.status).toBe(200);
    expect(res.body.sections).toHaveLength(0);
  });
});
