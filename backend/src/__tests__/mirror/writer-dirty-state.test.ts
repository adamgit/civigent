import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/writers/:id/dirty", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns 401 without auth", async () => {
    const res = await request(ctx.app)
      .get(`/api/writers/${ctx.humanId}/dirty`);

    expect(res.status).toBe(401);
  });

  it("with auth returns { writer_id, documents: [] } when nothing is dirty", async () => {
    const res = await request(ctx.app)
      .get(`/api/writers/${ctx.humanId}/dirty`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("writer_id");
    expect(res.body).toHaveProperty("documents");
    expect(Array.isArray(res.body.documents)).toBe(true);
    expect(res.body.documents).toHaveLength(0);
  });
});
