import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { issueTokenPair } from "../../auth/tokens.js";

describe("POST /api/auth/token/refresh", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("rotates both auth cookies and returns authenticated: true for a valid refresh cookie", async () => {
    const pair = issueTokenPair({
      id: "refresh-user",
      type: "human",
      displayName: "Refresh User",
    });

    const res = await request(ctx.app)
      .post("/api/auth/token/refresh")
      .set("Cookie", [`ks_refresh_token=${encodeURIComponent(pair.refresh_token)}`]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true });

    // Should set both ks_access_token and ks_refresh_token cookies
    const setCookies: string[] = res.headers["set-cookie"] ?? [];
    const hasAccess = setCookies.some((c: string) => c.startsWith("ks_access_token=") && !c.includes("Max-Age=0"));
    const hasRefresh = setCookies.some((c: string) => c.startsWith("ks_refresh_token=") && !c.includes("Max-Age=0"));
    expect(hasAccess).toBe(true);
    expect(hasRefresh).toBe(true);
  });

  it("returns 401 and clears cookies when no refresh cookie is provided", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/token/refresh");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ authenticated: false });

    // Should clear both cookies (Max-Age=0)
    const setCookies: string[] = res.headers["set-cookie"] ?? [];
    const accessCleared = setCookies.some((c: string) => c.startsWith("ks_access_token=") && c.includes("Max-Age=0"));
    const refreshCleared = setCookies.some((c: string) => c.startsWith("ks_refresh_token=") && c.includes("Max-Age=0"));
    expect(accessCleared).toBe(true);
    expect(refreshCleared).toBe(true);
  });

  it("returns 401 and clears cookies when refresh cookie is an invalid token", async () => {
    const res = await request(ctx.app)
      .post("/api/auth/token/refresh")
      .set("Cookie", ["ks_refresh_token=not-a-valid-jwt"]);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ authenticated: false });

    const setCookies: string[] = res.headers["set-cookie"] ?? [];
    const accessCleared = setCookies.some((c: string) => c.startsWith("ks_access_token=") && c.includes("Max-Age=0"));
    expect(accessCleared).toBe(true);
  });

  it("returns 401 when an access token is sent as the refresh cookie", async () => {
    // Access tokens have token_use=access, not refresh — exchangeRefreshToken rejects them
    const pair = issueTokenPair({
      id: "wrong-token-user",
      type: "human",
      displayName: "Wrong Token",
    });

    const res = await request(ctx.app)
      .post("/api/auth/token/refresh")
      .set("Cookie", [`ks_refresh_token=${encodeURIComponent(pair.access_token)}`]);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("ignores JSON body and reads only from cookies", async () => {
    const pair = issueTokenPair({
      id: "body-user",
      type: "human",
      displayName: "Body User",
    });

    // Send refresh_token in body but NOT in cookie — should fail
    const res = await request(ctx.app)
      .post("/api/auth/token/refresh")
      .send({ refresh_token: pair.refresh_token });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ authenticated: false });
  });
});
