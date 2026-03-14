import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("/api/admin/config", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("GET /api/admin/config returns config with preset_description", async () => {
    const res = await request(ctx.app)
      .get("/api/admin/config")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("preset_description");
  });

  it("PUT /api/admin/config with valid preset updates and returns new config", async () => {
    const res = await request(ctx.app)
      .put("/api/admin/config")
      .set("Authorization", ctx.humanToken)
      .send({ humanInvolvement_preset: "conservative" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("humanInvolvement_preset", "conservative");
    expect(res.body).toHaveProperty("preset_description");
  });

  it("PUT /api/admin/config with invalid preset returns 400", async () => {
    const res = await request(ctx.app)
      .put("/api/admin/config")
      .set("Authorization", ctx.humanToken)
      .send({ humanInvolvement_preset: "invalid_nonexistent_preset" });

    expect(res.status).toBe(400);
  });
});
