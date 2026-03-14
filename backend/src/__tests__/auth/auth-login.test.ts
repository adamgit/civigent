import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";

describe("POST /api/auth/login", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    process.env.KS_AUTH_MODE = "credentials";
    process.env.KS_AUTH_CREDENTIALS_USERNAME = "admin";
    process.env.KS_AUTH_CREDENTIALS_PASSWORD = "password123";
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
    delete process.env.KS_AUTH_MODE;
    delete process.env.KS_AUTH_CREDENTIALS_USERNAME;
    delete process.env.KS_AUTH_CREDENTIALS_PASSWORD;
  });

  it("returns tokens and sets HttpOnly cookies with valid credentials", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("access_token");
    expect(res.body).toHaveProperty("refresh_token");
    expect(res.body).toHaveProperty("user");

    // Check Set-Cookie headers for HttpOnly cookies
    const cookies = res.headers["set-cookie"];
    expect(cookies).toBeDefined();
    const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : String(cookies);
    expect(cookieStr).toContain("ks_access_token=");
    expect(cookieStr).toContain("HttpOnly");
  });

  it("returns 500 when credentials are invalid (service throws)", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/login")
      .send({ username: "wrong", password: "wrong" });

    expect(res.status).toBe(500);
  });

  it("returns 400 when username or password is missing", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/login")
      .send({ username: "admin" });

    expect(res.status).toBe(400);

    const res2 = await request(ctx.app)
      .post("/api/auth/login")
      .send({ password: "password123" });

    expect(res2.status).toBe(400);
  });
});
