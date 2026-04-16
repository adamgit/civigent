/**
 * Integration test: POST /api/admin/agents/:agentId/rotate-secret
 *
 * End-to-end verification that rotation makes the OLD secret unusable and the
 * NEW secret usable for OAuth token exchange, while preserving agent_id and
 * display_name.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";

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

async function getAuthCode(
  app: Express.Application,
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
): Promise<string> {
  const res = await request(app)
    .post("/oauth/authorize")
    .type("form")
    .send({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: "",
    });
  expect(res.status).toBe(302);
  const url = new URL(res.headers.location as string);
  const code = url.searchParams.get("code");
  expect(code).not.toBeNull();
  return code!;
}

describe("POST /api/admin/agents/:agentId/rotate-secret", () => {
  let ctx: TestServerContext;
  const AGENT_DISPLAY_NAME = "Rotation Test Agent";
  const REDIRECT_URI = "http://localhost:9999/callback";

  let savedPolicy: string | undefined;

  beforeAll(async () => {
    process.env.KS_OIDC_PUBLIC_URL = "http://localhost:3000";
    savedPolicy = process.env.KS_AGENT_AUTH_POLICY;
    process.env.KS_AGENT_AUTH_POLICY = "verify";
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
    delete process.env.KS_OIDC_PUBLIC_URL;
    if (savedPolicy === undefined) delete process.env.KS_AGENT_AUTH_POLICY;
    else process.env.KS_AGENT_AUTH_POLICY = savedPolicy;
  });

  it("rotates the secret, old secret fails token exchange, new secret succeeds, identity preserved", async () => {
    // 1. Create agent via admin endpoint
    const createRes = await request(ctx.app)
      .post("/api/admin/agents")
      .set("Authorization", ctx.humanToken)
      .send({ display_name: AGENT_DISPLAY_NAME });
    expect(createRes.status).toBe(201);
    const agentId = createRes.body.agent_id as string;
    const originalSecret = createRes.body.secret as string;
    expect(agentId).toMatch(/^agent-/);
    expect(originalSecret).toMatch(/^sk_[0-9a-f]{48}$/);

    // 2. Rotate the secret
    const rotateRes = await request(ctx.app)
      .post(`/api/admin/agents/${agentId}/rotate-secret`)
      .set("Authorization", ctx.humanToken)
      .send({});
    expect(rotateRes.status).toBe(200);
    const newSecret = rotateRes.body.secret as string;
    expect(newSecret).toBeTruthy();
    expect(newSecret).not.toBe(originalSecret);
    expect(rotateRes.body.agent_id).toBe(agentId);
    expect(rotateRes.body.display_name).toBe(AGENT_DISPLAY_NAME);

    // 3. OAuth token exchange with the OLD secret must now fail
    {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const authCode = await getAuthCode(ctx.app, agentId, REDIRECT_URI, codeChallenge);
      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: agentId,
          client_secret: originalSecret,
        });
      expect(tokenRes.status).toBe(401);
      expect(tokenRes.body.error).toBe("invalid_client");
    }

    // 4. OAuth token exchange with the NEW secret must succeed
    {
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const authCode = await getAuthCode(ctx.app, agentId, REDIRECT_URI, codeChallenge);
      const tokenRes = await request(ctx.app)
        .post("/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: agentId,
          client_secret: newSecret,
        });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body).toHaveProperty("access_token");
    }

    // 5. GET /api/admin/agents shows identity unchanged
    const listRes = await request(ctx.app)
      .get("/api/admin/agents")
      .set("Authorization", ctx.humanToken);
    expect(listRes.status).toBe(200);
    const found = (listRes.body.agents as Array<{ agent_id: string; display_name: string }>)
      .find((a) => a.agent_id === agentId);
    expect(found).toBeDefined();
    expect(found!.display_name).toBe(AGENT_DISPLAY_NAME);
  });

  it("returns error when rotating a non-existent agent", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/agents/agent-does-not-exist/rotate-secret")
      .set("Authorization", ctx.humanToken)
      .send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects agent-token callers (agents cannot rotate admin secrets)", async () => {
    const res = await request(ctx.app)
      .post("/api/admin/agents/some-agent/rotate-secret")
      .set("Authorization", ctx.agentToken)
      .send({});
    expect(res.status).toBe(403);
  });
});
