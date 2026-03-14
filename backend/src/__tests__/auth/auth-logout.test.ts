import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";

describe("POST /api/auth/logout", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns { success: true }", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/logout");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("sets cookies with Max-Age=0 to clear them", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/logout");

    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
    const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : String(cookies);
    expect(cookieStr).toContain("Max-Age=0");
    expect(cookieStr).toContain("ks_access_token=");
    expect(cookieStr).toContain("ks_refresh_token=");
  });
});
