import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";

describe("Auth session and methods", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  describe("GET /api/auth/session", () => {
    it("returns authenticated: true with user info when a valid token is provided", async () => {
      const res = await request(ctx.app)
        .get("/api/auth/session")
        .set("Authorization", ctx.humanToken);

      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(true);
      expect(res.body.user).toBeDefined();
      expect(res.body.user).toHaveProperty("id");
      expect(res.body.user).toHaveProperty("type");
      expect(res.body.user).toHaveProperty("displayName");
    });

    it("returns authenticated: false when no token is provided", async () => {
      const res = await request(ctx.app)
        .get("/api/auth/session");

      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(false);
    });
  });

  describe("GET /api/auth/methods", () => {
    it("returns a methods array", async () => {
      const res = await request(ctx.app)
        .get("/api/auth/methods");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("methods");
      expect(Array.isArray(res.body.methods)).toBe(true);
    });
  });
});
