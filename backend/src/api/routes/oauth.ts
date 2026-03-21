/**
 * OAuth 2.1 endpoints for MCP agent authentication.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource   — RFC 9728 PRM
 *   GET  /.well-known/oauth-authorization-server  — RFC 8414 AS metadata
 *   POST /oauth/register                          — RFC 7591 DCR
 *   GET  /oauth/authorize                         — Authorization (single-user auto-approve or consent)
 *   POST /oauth/authorize                         — Consent approval (multi-user)
 *   POST /oauth/token                             — Code exchange + refresh
 */

import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { getOidcPublicUrl, getAgentAuthPolicy } from "../../auth/oauth-config.js";
import { isSingleUserMode, resolveAuthenticatedWriter } from "../../auth/context.js";
import {
  mintAnonClientId,
  validateAnonClientId,
  mintAuthCode,
  validateAuthCode,
} from "../../auth/oauth-tokens.js";
import { lookupAgentBySecret, lookupAgentKey } from "../../auth/agent-keys.js";
import { issueTokenPair } from "../../auth/tokens.js";

// ─── Registration rate limiter (process-level, no deps) ─────────

const _registerThrottle = {
  count: 0,
  windowStart: Date.now(),
};
const REGISTER_WINDOW_MS = 60_000; // 1 minute
const REGISTER_MAX_PER_WINDOW = 10;

function checkRegisterRateLimit(): boolean {
  const now = Date.now();
  if (now - _registerThrottle.windowStart > REGISTER_WINDOW_MS) {
    _registerThrottle.count = 0;
    _registerThrottle.windowStart = now;
  }
  if (_registerThrottle.count >= REGISTER_MAX_PER_WINDOW) {
    return false; // rate limited
  }
  _registerThrottle.count++;
  return true;
}

// ─── Token endpoint rate limiter (process-level, no deps) ────────

const _tokenThrottle = {
  count: 0,
  windowStart: Date.now(),
};
const TOKEN_WINDOW_MS = 60_000; // 1 minute
const TOKEN_MAX_PER_WINDOW = 30;

function checkTokenRateLimit(): boolean {
  const now = Date.now();
  if (now - _tokenThrottle.windowStart > TOKEN_WINDOW_MS) {
    _tokenThrottle.count = 0;
    _tokenThrottle.windowStart = now;
  }
  if (_tokenThrottle.count >= TOKEN_MAX_PER_WINDOW) {
    return false;
  }
  _tokenThrottle.count++;
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Resolve a client_id to agent identity.
 * Tries anonymous token validation first, then agents.keys lookup.
 * Returns { type, agentId, agentName } or null.
 */
async function resolveClientId(clientId: string): Promise<{
  type: "anonymous" | "pre_auth";
  agentId: string;
  agentName: string;
} | null> {
  // Try anonymous signed token first
  const anon = validateAnonClientId(clientId);
  if (anon) {
    return { type: "anonymous", agentId: anon.agent_id, agentName: anon.agent_name };
  }

  // Try pre-authenticated lookup
  const entry = await lookupAgentKey(clientId);
  if (entry) {
    return { type: "pre_auth", agentId: entry.agentId, agentName: entry.displayName };
  }

  return null;
}

// ─── Router ──────────────────────────────────────────────────────

export function createOAuthRouter(): Router {
  const router = Router();

  // ── Discovery: Protected Resource Metadata (RFC 9728) ──────

  router.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    const publicUrl = getOidcPublicUrl();
    res.json({
      resource: publicUrl,
      authorization_servers: [publicUrl],
    });
  });

  // ── Discovery: Authorization Server Metadata (RFC 8414) ────

  router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    const publicUrl = getOidcPublicUrl();
    res.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    });
  });

  // ── DCR: Dynamic Client Registration (RFC 7591) ────────────

  router.post("/oauth/register", async (req: Request, res: Response) => {
    if (!checkRegisterRateLimit()) {
      res.status(429).json({
        error: "too_many_requests",
        error_description: "Too many registration requests. Try again later.",
      });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const clientName = typeof body.client_name === "string" ? body.client_name.trim() : "";
    const clientSecret = typeof body.client_secret === "string" ? body.client_secret : null;
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code"];

    // Path 1: Pre-authenticated agent (has client_secret)
    if (clientSecret) {
      const entry = await lookupAgentBySecret(clientSecret);
      if (!entry) {
        res.status(401).json({ error: "invalid_client", error_description: "Invalid client secret." });
        return;
      }
      res.status(201).json({
        client_id: entry.agentId,
        client_name: entry.displayName,
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        token_endpoint_auth_method: "client_secret_post",
      });
      return;
    }

    // Path 2: Anonymous agent (no client_secret)
    if (getAgentAuthPolicy() !== "open") {
      res.status(403).json({
        error: "access_denied",
        error_description: "Anonymous agent registration is disabled. Contact the administrator to register a named agent identity.",
      });
      return;
    }

    if (!clientName) {
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description: "client_name is required.",
      });
      return;
    }

    const clientId = mintAnonClientId(clientName);
    res.status(201).json({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      token_endpoint_auth_method: "none",
    });
  });

  // ── Authorization endpoint ─────────────────────────────────

  router.get("/oauth/authorize", async (req: Request, res: Response) => {
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
    const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
    const codeChallenge = typeof req.query.code_challenge === "string" ? req.query.code_challenge : "";
    const codeChallengeMethod = typeof req.query.code_challenge_method === "string"
      ? req.query.code_challenge_method : "S256";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const responseType = typeof req.query.response_type === "string" ? req.query.response_type : "code";

    // Validate required params
    if (!clientId || !redirectUri || !codeChallenge) {
      res.status(400).send("Missing required OAuth parameters (client_id, redirect_uri, code_challenge).");
      return;
    }
    if (responseType !== "code") {
      res.status(400).send("Only response_type=code is supported.");
      return;
    }

    // Validate client_id
    const client = await resolveClientId(clientId);
    if (!client) {
      res.status(400).send("Invalid or expired client_id.");
      return;
    }

    if (isSingleUserMode()) {
      // Single-user auto-approve: serve HTML that auto-redirects after brief display
      const code = mintAuthCode(clientId, redirectUri, codeChallenge, codeChallengeMethod);
      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set("code", code);
      if (state) redirectTarget.searchParams.set("state", state);
      const finalUrl = redirectTarget.toString();

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Agent Connecting</title>
  <meta http-equiv="refresh" content="3;url=${escapeHtml(finalUrl)}">
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f8f8f6; }
    .card { background: white; padding: 2rem 3rem; border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
    h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
    p { color: #666; font-size: 0.9rem; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Agent &ldquo;${escapeHtml(client.agentName)}&rdquo; is connecting&hellip;</h1>
    <p>Redirecting automatically in 3 seconds.</p>
  </div>
</body>
</html>`);
      return;
    }

    // Multi-user mode: require human session before showing consent page
    const writer = resolveAuthenticatedWriter(req);
    if (!writer) {
      // No session — redirect to login with return_to back to this authorize URL
      const returnTo = req.originalUrl;
      res.redirect(302, `/login?return_to=${encodeURIComponent(returnTo)}`);
      return;
    }
    if (writer.type === "agent") {
      res.status(403).send("Agents cannot approve their own authorization.");
      return;
    }

    const agentDisplayName = escapeHtml(client.agentName);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize Agent</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f8f8f6; }
    .card { background: white; padding: 2rem 3rem; border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
    h1 { font-size: 1.1rem; margin: 0 0 1rem; }
    p { color: #666; font-size: 0.9rem; margin: 0 0 1.5rem; }
    button { background: #2d7a8a; color: white; border: none; padding: 0.6rem 2rem;
             border-radius: 4px; font-size: 0.95rem; cursor: pointer; }
    button:hover { background: #256a78; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Allow &ldquo;${agentDisplayName}&rdquo; to connect to this Knowledge Store?</h1>
    <p>This agent will be able to read and propose changes to documents.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <button type="submit">Allow</button>
    </form>
  </div>
</body>
</html>`);
  });

  // ── Consent approval (POST) ────────────────────────────────

  router.post("/oauth/authorize", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const clientId = typeof body.client_id === "string" ? body.client_id : "";
    const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
    const codeChallenge = typeof body.code_challenge === "string" ? body.code_challenge : "";
    const codeChallengeMethod = typeof body.code_challenge_method === "string"
      ? body.code_challenge_method : "S256";
    const state = typeof body.state === "string" ? body.state : "";

    // In multi-user mode, require a valid human session before minting auth codes
    if (!isSingleUserMode()) {
      const writer = resolveAuthenticatedWriter(req);
      if (!writer) {
        // Reconstruct the authorize URL for return_to
        const params = new URLSearchParams();
        if (clientId) params.set("client_id", clientId);
        if (redirectUri) params.set("redirect_uri", redirectUri);
        if (codeChallenge) params.set("code_challenge", codeChallenge);
        if (codeChallengeMethod) params.set("code_challenge_method", codeChallengeMethod);
        if (state) params.set("state", state);
        res.redirect(302, `/login?return_to=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`);
        return;
      }
      if (writer.type === "agent") {
        res.status(403).send("Agents cannot approve their own authorization.");
        return;
      }
    }

    if (!clientId || !redirectUri || !codeChallenge) {
      res.status(400).send("Missing required parameters.");
      return;
    }

    const client = await resolveClientId(clientId);
    if (!client) {
      res.status(400).send("Invalid or expired client_id.");
      return;
    }

    const code = mintAuthCode(clientId, redirectUri, codeChallenge, codeChallengeMethod);
    const redirectTarget = new URL(redirectUri);
    redirectTarget.searchParams.set("code", code);
    if (state) redirectTarget.searchParams.set("state", state);

    res.redirect(302, redirectTarget.toString());
  });

  // ── Token endpoint ─────────────────────────────────────────

  router.post("/oauth/token", async (req: Request, res: Response) => {
    if (!checkTokenRateLimit()) {
      res.status(429)
        .setHeader("Retry-After", "60")
        .json({
          error: "too_many_requests",
          error_description: "Too many token requests. Try again later.",
        });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const grantType = typeof body.grant_type === "string" ? body.grant_type : "";

    if (grantType === "authorization_code") {
      await handleAuthCodeGrant(req, res);
    } else if (grantType === "refresh_token") {
      await handleRefreshGrant(req, res);
    } else {
      res.status(400).json({
        error: "unsupported_grant_type",
        error_description: `Unsupported grant_type: ${grantType}`,
      });
    }
  });

  return router;
}

// ─── Token grant handlers ────────────────────────────────────────

async function handleAuthCodeGrant(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code : "";
  const codeVerifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  const clientSecret = typeof body.client_secret === "string" ? body.client_secret : null;

  if (!code || !codeVerifier) {
    res.status(400).json({ error: "invalid_request", error_description: "code and code_verifier are required." });
    return;
  }

  // Validate auth code
  const authCode = validateAuthCode(code);
  if (!authCode) {
    res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code." });
    return;
  }

  // Verify client_id matches
  if (clientId && clientId !== authCode.client_id) {
    res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch." });
    return;
  }

  // PKCE verification: SHA256(code_verifier) must equal code_challenge
  const computedChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  if (computedChallenge !== authCode.code_challenge) {
    res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
    return;
  }

  // Resolve client identity and enforce auth method
  const resolvedClientId = authCode.client_id;

  // Try anonymous first
  const anon = validateAnonClientId(resolvedClientId);
  if (anon) {
    // Anonymous client — no secret required
    const tokens = issueTokenPair({
      id: anon.agent_id,
      type: "agent",
      displayName: anon.agent_name,
    });
    res.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: "Bearer",
    });
    return;
  }

  // Try pre-authenticated
  const preAuth = await lookupAgentKey(resolvedClientId);
  if (preAuth) {
    const policy = getAgentAuthPolicy();
    if (policy === "verify") {
      // verify: client_secret is mandatory
      if (!clientSecret) {
        res.status(401).json({
          error: "invalid_client",
          error_description: "client_secret is required (policy: verify).",
        });
        return;
      }
      if (preAuth.secretHash === "none") {
        res.status(401).json({
          error: "invalid_client",
          error_description: "Agent was registered without a secret. Re-register the agent with a secret to use verify policy.",
        });
        return;
      }
      const { compareSecret } = await import("../../auth/agent-keys.js");
      const secretValid = await compareSecret(clientSecret, preAuth.secretHash);
      if (!secretValid) {
        res.status(401).json({
          error: "invalid_client",
          error_description: "Invalid client_secret.",
        });
        return;
      }
    }
    // open / register: client_id in agents.keys is sufficient — issue the token
    const tokens = issueTokenPair({
      id: preAuth.agentId,
      type: "agent",
      displayName: preAuth.displayName,
    });
    res.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: "Bearer",
    });
    return;
  }

  // Unknown client_id
  res.status(400).json({ error: "invalid_client", error_description: "Unknown client_id." });
}

async function handleRefreshGrant(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";

  if (!refreshToken) {
    res.status(400).json({ error: "invalid_request", error_description: "refresh_token is required." });
    return;
  }

  try {
    const { exchangeRefreshToken } = await import("../../auth/service.js");
    const tokens = exchangeRefreshToken(refreshToken);
    res.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: "Bearer",
    });
  } catch (err) {
    res.status(401).json({
      error: "invalid_grant",
      error_description: (err as Error).message,
    });
  }
}

// ─── HTML escaping ───────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
