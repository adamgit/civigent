import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument } from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("POST /api/publish", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("requires auth", async () => {
    const res = await request(ctx.app)
      .post("/api/publish");

    expect(res.status).toBe(401);
  });

  it("returns 403 for agent callers (agents can't publish)", async () => {
    const res = await request(ctx.app)
      .post("/api/publish")
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(403);
  });

  it("returns 404 when no dirty sections exist (for human caller)", async () => {
    const res = await request(ctx.app)
      .post("/api/publish")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(404);
  });
});
