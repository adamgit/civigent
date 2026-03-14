import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

describe("Auth middleware enforcement", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns 401 when no token is provided on a protected endpoint", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .send({
        doc_path: SAMPLE_DOC_PATH,
        heading_path: [],
        proposed_markdown: "Some new content",
      });

    expect(res.status).toBe(401);
  });

  it("succeeds with a valid Bearer token on a protected endpoint", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        doc_path: SAMPLE_DOC_PATH,
        heading_path: [],
        proposed_markdown: "Some new content",
      });

    // Should not be 401 — the request is authenticated
    expect(res.status).not.toBe(401);
  });
});
