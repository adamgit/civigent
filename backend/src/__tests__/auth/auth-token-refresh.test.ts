import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  decodeAndValidateToken,
  issueScopedTokenPair,
  issueTokenPair,
} from "../../auth/tokens.js";
import { base64UrlEncode } from "../../auth/encoding.js";
import { getShareSalt } from "../../auth/oauth-config.js";

function cookieValue(setCookies: string[], name: string): string | undefined {
  const header = setCookies.find((c) => c.startsWith(`${name}=`));
  if (!header) return undefined;
  const raw = header.split(";")[0]!.slice(name.length + 1);
  return decodeURIComponent(raw);
}

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

  it("keeps auth_source and scope on a scoped refresh", async () => {
    const grantExp = Math.floor(Date.now() / 1000) + 3600;
    const pair = issueScopedTokenPair(
      { id: "human-share-refresh", type: "human", displayName: "Share Guest" },
      {
        docPath: "/shared.md",
        action: "write",
        grantJti: "grant-jti-refresh",
        grantExp,
      },
    );

    const res = await request(ctx.app)
      .post("/api/auth/token/refresh")
      .set("Cookie", [`ks_refresh_token=${encodeURIComponent(pair.refresh_token)}`]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true });

    const setCookies: string[] = res.headers["set-cookie"] ?? [];
    const access = cookieValue(setCookies, "ks_access_token");
    const refresh = cookieValue(setCookies, "ks_refresh_token");
    expect(access).toBeDefined();
    expect(refresh).toBeDefined();

    const accessClaims = decodeAndValidateToken(access!);
    const refreshClaims = decodeAndValidateToken(refresh!);
    expect(accessClaims.auth_source).toBe("share");
    expect(accessClaims.scope_doc).toBe("/shared.md");
    expect(accessClaims.scope_action).toBe("write");
    expect(accessClaims.grant_exp).toBe(grantExp);
    expect(refreshClaims.auth_source).toBe("share");
    expect(refreshClaims.scope_doc).toBe("/shared.md");
    expect(refreshClaims.grant_exp).toBe(grantExp);
  });

  it("returns 401 and clears cookies when grant_exp has passed", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64UrlEncode(
      JSON.stringify({
        sub: "human-share-expired",
        type: "human",
        display_name: "Expired Guest",
        token_use: "refresh",
        iat: nowSeconds,
        exp: nowSeconds + 1800,
        jti: "expired-grant-refresh",
        auth_source: "share",
        scope_doc: "/shared.md",
        scope_action: "write",
        grant_jti: "grant-jti-expired",
        grant_exp: nowSeconds - 10,
      }),
    );
    const signature = base64UrlEncode(
      createHmac("sha256", getShareSalt()).update(`${header}.${payload}`).digest(),
    );
    const expiredGrantRefresh = `${header}.${payload}.${signature}`;

    const res = await request(ctx.app)
      .post("/api/auth/token/refresh")
      .set("Cookie", [`ks_refresh_token=${encodeURIComponent(expiredGrantRefresh)}`]);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ authenticated: false });

    const setCookies: string[] = res.headers["set-cookie"] ?? [];
    const accessCleared = setCookies.some((c: string) => c.startsWith("ks_access_token=") && c.includes("Max-Age=0"));
    const refreshCleared = setCookies.some((c: string) => c.startsWith("ks_refresh_token=") && c.includes("Max-Age=0"));
    expect(accessCleared).toBe(true);
    expect(refreshCleared).toBe(true);
  });
});
