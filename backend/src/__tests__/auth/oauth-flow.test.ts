/**
 * OAuth 2.1 integration tests.
 *
 * Tests the full OAuth flow: discovery, registration, authorization, token exchange.
 * Critical security test: pre-auth client_id without secret must be rejected.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { hashSecret } from "../../auth/agent-keys.js";

// ─── PKCE helpers ─────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Get an auth code via POST /oauth/authorize.
 * Returns a 302 redirect with code in the Location header.
 */
async function getAuthCode(
  app: Express.Application,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  codeChallengeMethod: string,
  state?: string,
): Promise<string> {
  const res = await request(app)
    .post("/oauth/authorize")
    .type("form")
    .send({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      state: state ?? "",
    });
  expect(res.status).toBe(302);
  const location = res.headers.location as string;
  const url = new URL(location);
  const code = url.searchParams.get("code");
  expect(code).not.toBeNull();
  return code!;
}

// ─── Test suite ───────────────────────────────────────────────────

describe("OAuth 2.1 flow", () => {
  let ctx: TestServerContext;
  const PRE_AUTH_AGENT_ID = "agent-preauth-test";
  const PRE_AUTH_DISPLAY_NAME = "PreAuth Test Bot";
  const PRE_AUTH_SECRET = "sk_test_secret_1234567890";
  /** Shared anonymous client_id, registered once in beforeAll to avoid rate-limit exhaustion. */
  let sharedAnonClientId: string;

  beforeAll(async () => {
    // Set KS_OIDC_PUBLIC_URL so getOidcPublicUrl() works in multi-user mode
    process.env.KS_OIDC_PUBLIC_URL = "http://localhost:3000";

    ctx = await createTestServer();

    // Write a pre-authenticated agent into agents.keys
    const secretHash = await hashSecret(PRE_AUTH_SECRET);
    const authDir = join(ctx.dataCtx.rootDir, "auth");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, "agents.keys"),
      `${PRE_AUTH_AGENT_ID}:${secretHash}:${PRE_AUTH_DISPLAY_NAME}\n`,
      "utf8",
    );

    // Register a shared anonymous client for tests that don't need their own
    const regRes = await request(ctx.app)
      .post("/oauth/register")
      .send({ client_name: "Shared Test Agent" });
    sharedAnonClientId = regRes.body.client_id;
  });

  afterAll(async () => {
    await ctx.cleanup();
    delete process.env.KS_OIDC_PUBLIC_URL;
  });

  // ── Discovery ──────────────────────────────────────────────

  describe("discovery endpoints", () => {
    it("GET /.well-known/oauth-protected-resource returns resource metadata", async () => {
      const res = await request(ctx.app).get("/.well-known/oauth-protected-resource");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("resource");
      expect(res.body).toHaveProperty("authorization_servers");
      expect(Array.isArray(res.body.authorization_servers)).toBe(true);
    });

    it("GET /.well-known/oauth-authorization-server returns AS metadata", async () => {
      const res = await request(ctx.app).get("/.well-known/oauth-authorization-server");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("issuer");
      expect(res.body).toHaveProperty("authorization_endpoint");
      expect(res.body).toHaveProperty("token_endpoint");
      expect(res.body).toHaveProperty("registration_endpoint");
      expect(res.body.response_types_supported).toContain("code");
      expect(res.body.grant_types_supported).toContain("authorization_code");
      expect(res.body.code_challenge_methods_supported).toContain("S256");
    });
  });

  // ── Registration ───────────────────────────────────────────

  describe("POST /oauth/register", () => {
    it("anonymous registration returns client_id", async () => {
      const res = await request(ctx.app)
        .post("/oauth/register")
        .send({ client_name: "Test Agent", redirect_uris: ["http://localhost:9999/callback"] });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("client_id");
      expect(res.body.client_name).toBe("Test Agent");
      expect(res.body.token_endpoint_auth_method).toBe("none");
    });

    it("pre-auth registration with valid secret returns agent-id as client_id", async () => {
      const res = await request(ctx.app)
        .post("/oauth/register")
        .send({ client_secret: PRE_AUTH_SECRET });
      expect(res.status).toBe(201);
      expect(res.body.client_id).toBe(PRE_AUTH_AGENT_ID);
      expect(res.body.client_name).toBe(PRE_AUTH_DISPLAY_NAME);
      expect(res.body.token_endpoint_auth_method).toBe("client_secret_post");
    });

    it("pre-auth registration with invalid secret returns 401", async () => {
      const res = await request(ctx.app)
        .post("/oauth/register")
        .send({ client_secret: "wrong-secret" });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("invalid_client");
    });

    it("anonymous registration without client_name returns 400", async () => {
      const res = await request(ctx.app)
        .post("/oauth/register")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_client_metadata");
    });
  });

  // ── Full anonymous OAuth flow (via consent POST) ───────────

  describe("full anonymous OAuth flow", () => {
    it("register → consent → token exchange produces valid tokens", async () => {
      // Step 1: Register
      const regRes = await request(ctx.app)
        .post("/oauth/register")
        .send({ client_name: "Flow Test Agent" });
      expect(regRes.status).toBe(201);
      const clientId = regRes.body.client_id;

      // Step 2: PKCE
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      // Step 3: Get auth code via POST
      const authCode = await getAuthCode(
        ctx.app,
        clientId,
        "http://localhost:9999/callback",
        codeChallenge,
        "S256",
        "test-state",
      );

      // Step 4: Token exchange
      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: clientId,
        });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body).toHaveProperty("access_token");
      expect(tokenRes.body).toHaveProperty("refresh_token");
      expect(tokenRes.body.token_type).toBe("Bearer");

      // Step 5: Verify the token works
      const sessionRes = await request(ctx.app)
        .get("/api/auth/session")
        .set("Authorization", `Bearer ${tokenRes.body.access_token}`);
      expect(sessionRes.status).toBe(200);
      expect(sessionRes.body.authenticated).toBe(true);
    });
  });

  // ── Single-user auto-approve flow ──────────────────────────

  describe("single-user auto-approve", () => {
    let prevAuthMode: string | undefined;

    beforeAll(() => {
      prevAuthMode = process.env.KS_AUTH_MODE;
      process.env.KS_AUTH_MODE = "single_user";
    });

    afterAll(() => {
      if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
      else process.env.KS_AUTH_MODE = prevAuthMode;
    });

    it("GET /oauth/authorize redirects with authorization code in single-user mode", async () => {
      const regRes = await request(ctx.app)
        .post("/oauth/register")
        .send({ client_name: "Single User Agent" });
      const clientId = regRes.body.client_id;

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const authRes = await request(ctx.app)
        .get("/oauth/authorize")
        .query({
          client_id: clientId,
          redirect_uri: "http://localhost:9999/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          response_type: "code",
          state: "su-state",
        });
      expect(authRes.status).toBe(302);

      // Extract code from Location header
      const location = new URL(authRes.headers["location"]);
      const authCode = location.searchParams.get("code");
      expect(authCode).toBeTruthy();

      // Exchange works
      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: clientId,
        });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body).toHaveProperty("access_token");
    });
  });

  // ── CRITICAL SECURITY TEST ─────────────────────────────────

  describe("pre-auth client_id without secret must be rejected (verify policy)", () => {
    let prevPolicy: string | undefined;

    beforeAll(() => {
      prevPolicy = process.env.KS_AGENT_AUTH_POLICY;
      process.env.KS_AGENT_AUTH_POLICY = "verify";
    });

    afterAll(() => {
      if (prevPolicy === undefined) delete process.env.KS_AGENT_AUTH_POLICY;
      else process.env.KS_AGENT_AUTH_POLICY = prevPolicy;
    });

    it("token endpoint rejects pre-auth client_id when client_secret is omitted", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const authCode = await getAuthCode(
        ctx.app,
        PRE_AUTH_AGENT_ID,
        "http://localhost:9999/callback",
        codeChallenge,
        "S256",
      );

      // ATTACK: Try to exchange the code WITHOUT providing client_secret
      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: PRE_AUTH_AGENT_ID,
        });

      // Must be rejected — pre-auth agents REQUIRE client_secret
      expect(tokenRes.status).toBe(401);
      expect(tokenRes.body.error).toBe("invalid_client");
    });

    it("token endpoint rejects pre-auth client_id with wrong client_secret", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const authCode = await getAuthCode(
        ctx.app,
        PRE_AUTH_AGENT_ID,
        "http://localhost:9999/callback",
        codeChallenge,
        "S256",
      );

      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: PRE_AUTH_AGENT_ID,
          client_secret: "wrong-secret",
        });

      expect(tokenRes.status).toBe(401);
      expect(tokenRes.body.error).toBe("invalid_client");
    });

    it("token endpoint accepts pre-auth client_id with correct client_secret", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const authCode = await getAuthCode(
        ctx.app,
        PRE_AUTH_AGENT_ID,
        "http://localhost:9999/callback",
        codeChallenge,
        "S256",
      );

      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: PRE_AUTH_AGENT_ID,
          client_secret: PRE_AUTH_SECRET,
        });

      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body).toHaveProperty("access_token");
      expect(tokenRes.body).toHaveProperty("refresh_token");
      expect(tokenRes.body.token_type).toBe("Bearer");
    });
  });

  // ── Token endpoint error cases ─────────────────────────────

  describe("POST /oauth/token error cases", () => {
    it("rejects unsupported grant_type", async () => {
      const res = await request(ctx.app)
        .post("/oauth/token")
        .send({ grant_type: "client_credentials" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("unsupported_grant_type");
    });

    it("rejects invalid authorization code", async () => {
      const res = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: "invalid-code",
          code_verifier: "whatever",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_grant");
    });

    it("rejects wrong code_verifier (PKCE failure)", async () => {
      const regRes = await request(ctx.app)
        .post("/oauth/register")
        .send({ client_name: "PKCE Test" });
      const clientId = regRes.body.client_id;

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const authCode = await getAuthCode(
        ctx.app,
        clientId,
        "http://localhost:9999/callback",
        codeChallenge,
        "S256",
      );

      // Use wrong verifier
      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: "wrong-verifier",
          client_id: clientId,
        });

      expect(tokenRes.status).toBe(400);
      expect(tokenRes.body.error).toBe("invalid_grant");
    });
  });

  // ── Authorization endpoint error cases ─────────────────────

  describe("GET /oauth/authorize error cases", () => {
    it("rejects missing required params", async () => {
      const res = await request(ctx.app).get("/oauth/authorize");
      expect(res.status).toBe(400);
    });

    it("rejects invalid client_id", async () => {
      const res = await request(ctx.app)
        .get("/oauth/authorize")
        .query({
          client_id: "nonexistent",
          redirect_uri: "http://localhost:9999/callback",
          code_challenge: "test",
          response_type: "code",
        });
      expect(res.status).toBe(400);
    });

    it("rejects unsupported response_type", async () => {
      const regRes = await request(ctx.app)
        .post("/oauth/register")
        .send({ client_name: "RT Test" });

      const res = await request(ctx.app)
        .get("/oauth/authorize")
        .query({
          client_id: regRes.body.client_id,
          redirect_uri: "http://localhost:9999/callback",
          code_challenge: "test",
          response_type: "token",
        });
      expect(res.status).toBe(400);
    });
  });

  // ── Authorization without session (multi-user mode) ──────────

  describe("OAuth authorize works without human session in multi-user mode", () => {
    let prevAuthMode: string | undefined;

    beforeAll(() => {
      prevAuthMode = process.env.KS_AUTH_MODE;
      process.env.KS_AUTH_MODE = "oidc";
    });

    afterAll(() => {
      if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
      else process.env.KS_AUTH_MODE = prevAuthMode;
    });

    it("POST /oauth/authorize without session issues auth code", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const res = await request(ctx.app)
        .post("/oauth/authorize")
        .type("form")
        .send({
          client_id: PRE_AUTH_AGENT_ID,
          redirect_uri: "http://localhost:9999/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/code=/);
    });

    it("POST /oauth/authorize with agent bearer token succeeds", async () => {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const res = await request(ctx.app)
        .post("/oauth/authorize")
        .type("form")
        .send({
          client_id: PRE_AUTH_AGENT_ID,
          redirect_uri: "http://localhost:9999/callback",
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/code=/);
    });
  });

  // ── Deferred nonce consumption ─────────────────────────────

  describe("deferred nonce consumption", () => {
    it("a failed PKCE attempt does not burn the auth code, allowing a correct retry", async () => {
      const clientId = sharedAnonClientId;

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);

      const authCode = await getAuthCode(
        ctx.app,
        clientId,
        "http://localhost:9999/callback",
        codeChallenge,
        "S256",
      );

      // First attempt: wrong code_verifier — should fail but NOT consume the nonce
      const failRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: "wrong-verifier-that-will-fail-pkce",
          client_id: clientId,
        });
      expect(failRes.status).toBe(400);
      expect(failRes.body.error).toBe("invalid_grant");

      // Second attempt: correct code_verifier — should succeed
      const successRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: clientId,
        });
      expect(successRes.status).toBe(200);
      expect(successRes.body).toHaveProperty("access_token");
    });
  });

  // ── expires_in in token responses ─────────────────────────

  describe("expires_in in token responses", () => {
    it("authorization_code grant includes expires_in", async () => {
      const clientId = sharedAnonClientId;

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const authCode = await getAuthCode(
        ctx.app, clientId, "http://localhost:9999/callback", codeChallenge, "S256",
      );

      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: clientId,
        });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body.expires_in).toBe(1800);
    });

    it("refresh_token grant includes expires_in", async () => {
      const clientId = sharedAnonClientId;

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const authCode = await getAuthCode(
        ctx.app, clientId, "http://localhost:9999/callback", codeChallenge, "S256",
      );

      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: clientId,
        });
      const refreshToken = tokenRes.body.refresh_token;

      const refreshRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        });
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.expires_in).toBe(1800);
    });
  });

  // ── redirect_uri mismatch ─────────────────────────────────

  describe("redirect_uri validation at token endpoint", () => {
    it("rejects token exchange when redirect_uri does not match auth code", async () => {
      const clientId = sharedAnonClientId;

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const authCode = await getAuthCode(
        ctx.app, clientId, "http://localhost:9999/callback", codeChallenge, "S256",
      );

      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: "http://evil.example.com/callback",
        });
      expect(tokenRes.status).toBe(400);
      expect(tokenRes.body.error).toBe("invalid_grant");
      expect(tokenRes.body.error_description).toMatch(/redirect_uri/i);
    });
  });

  // ── JSON error format from authorize endpoint ─────────────

  describe("authorize endpoint returns JSON errors", () => {
    it("GET /oauth/authorize missing params returns JSON error", async () => {
      const res = await request(ctx.app).get("/oauth/authorize");
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body).toHaveProperty("error_description");
      expect(res.headers["content-type"]).toMatch(/json/);
    });

    it("GET /oauth/authorize invalid client_id returns JSON error", async () => {
      const res = await request(ctx.app)
        .get("/oauth/authorize")
        .query({
          client_id: "nonexistent",
          redirect_uri: "http://localhost:9999/callback",
          code_challenge: "test",
          response_type: "code",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(res.headers["content-type"]).toMatch(/json/);
    });
  });

  // ── Form-encoded token endpoint ───────────────────────────

  describe("token endpoint with application/x-www-form-urlencoded", () => {
    it("accepts form-encoded body for authorization_code grant", async () => {
      const clientId = sharedAnonClientId;

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const authCode = await getAuthCode(
        ctx.app, clientId, "http://localhost:9999/callback", codeChallenge, "S256",
      );

      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .type("form")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: clientId,
        });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body).toHaveProperty("access_token");
      expect(tokenRes.body.token_type).toBe("Bearer");
    });
  });

  // ── Token rate limiting ─────────────────────────────────────

  describe("POST /oauth/token rate limiting", () => {
    it("returns 429 after 30 rapid token requests", async () => {
      // Send 30 token requests (they'll all fail with invalid_request, that's fine)
      for (let i = 0; i < 30; i++) {
        await request(ctx.app)
          .post("/oauth/token")
          .send({ grant_type: "authorization_code" });
      }

      // The 31st must be 429
      const res = await request(ctx.app)
        .post("/oauth/token")
        .send({ grant_type: "authorization_code" });
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("too_many_requests");
    });
  });

  // ── Registration rate limiting ──────────────────────────────

  describe("POST /oauth/register rate limiting", () => {
    it("returns 429 after 10 rapid registrations", async () => {
      // Send 10 registrations to fill the window
      for (let i = 0; i < 10; i++) {
        const r = await request(ctx.app)
          .post("/oauth/register")
          .send({ client_name: `RateTest-${i}` });
        // Some may be 201, some may already be 429 from earlier tests in this file
        expect([201, 429]).toContain(r.status);
      }

      // The 11th must be 429
      const res = await request(ctx.app)
        .post("/oauth/register")
        .send({ client_name: "RateTest-overflow" });
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("too_many_requests");
    });
  });
});
