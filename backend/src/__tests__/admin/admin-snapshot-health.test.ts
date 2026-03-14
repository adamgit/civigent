import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/admin/snapshot-health", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns health status object", async () => {
    const res = await request(ctx.app)
      .get("/api/admin/snapshot-health")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
    expect(res.body).not.toBeNull();
  });
});
