/**
 * OAuth 2.1 endpoints for MCP agent authentication.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-protected-resource   — RFC 9728 PRM
 *   GET  /.well-known/oauth-authorization-server  — RFC 8414 AS metadata
 *   POST /oauth/register                          — RFC 7591 DCR
 *   GET  /oauth/authorize                         — Authorization (auto-approve or consent redirect, 302)
 *   POST /oauth/authorize                         — Authorization via POST (auto-approve or human consent, 302)
 *   POST /oauth/token                             — Code exchange + refresh
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { base64UrlEncode } from "../../auth/encoding.js";
import {
  getMCPPublicURL,
  getAgentAuthPolicy,
  allowsAnonymousDcr,
  requiresPreRegisteredClient,
  requiresHumanConsent,
  requiresClientSecretAtToken,
} from "../../auth/oauth-config.js";
import { resolveAuthenticatedWriter } from "../../auth/context.js";
import {
  mintAnonClientId,
  validateAnonClientId,
  mintAuthCode,
  validateAuthCode,
  consumeAuthCode,
} from "../../auth/oauth-tokens.js";
import { lookupAgentBySecret, lookupAgentKey } from "../../auth/agent-keys.js";
import { issueTokenPair, ACCESS_TTL_SECONDS } from "../../auth/tokens.js";
import {
  OAuthDynamicClientRegistrationRequest,
  OAuthAuthorizationRequest,
  OAuthTokenRequest,
  type OAuthAuthorizationCodeTokenRequest,
  type OAuthRefreshTokenRequest,
  type OAuthTokenResponse,
  type OAuthErrorResponse,
  type OAuthAuthorizationServerMetadata,
  type OAuthProtectedResourceMetadata,
} from "../../auth/oauth-types.js";

/** Send an RFC 6749 §5.2 OAuth error response with the given HTTP status. */
function sendOAuthError(res: Response, status: number, error: string, description: string): void {
  const body: OAuthErrorResponse = { error, error_description: description };
  res.status(status).json(body);
}

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

  router.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
    const publicUrl = getMCPPublicURL(req);
    const metadata: OAuthProtectedResourceMetadata = {
      resource: publicUrl,
      authorization_servers: [publicUrl],
    };
    res.json(metadata);
  });

  // ── Discovery: Authorization Server Metadata (RFC 8414) ────

  router.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
    const publicUrl = getMCPPublicURL(req);
    const metadata: OAuthAuthorizationServerMetadata = {
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    };
    res.json(metadata);
  });

  // ── DCR: Dynamic Client Registration (RFC 7591) ────────────

  router.post("/oauth/register", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkRegisterRateLimit()) {
        sendOAuthError(res, 429, "too_many_requests", "Too many registration requests. Try again later.");
        return;
      }
      const registration = OAuthDynamicClientRegistrationRequest.parse(req.body);
      const clientName = registration.client_name?.trim() ?? "";
      const clientSecret = registration.client_secret ?? null;
      const redirectUris = registration.redirect_uris;
      const grantTypes = registration.grant_types;

      // Path 1: Pre-authenticated agent (has client_secret)
      if (clientSecret) {
        const entry = await lookupAgentBySecret(clientSecret);
        if (!entry) {
          sendOAuthError(res, 401, "invalid_client", "Invalid client secret.");
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
      if (!allowsAnonymousDcr(getAgentAuthPolicy())) {
        sendOAuthError(res, 403, "access_denied", "Anonymous agent registration is disabled. Contact the administrator to register a named agent identity.");
        return;
      }

      if (!clientName) {
        sendOAuthError(res, 400, "invalid_client_metadata", "client_name is required.");
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
    } catch (error) {
      next(error);
    }
  });

  // ── Authorization endpoint ─────────────────────────────────

  router.get("/oauth/authorize", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authRequest = OAuthAuthorizationRequest.parseQuery(req.query);
      const { client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge } = authRequest;

      // Validate required params — JSON 400 (cannot trust redirect_uri until client_id validated)
      if (!clientId || !redirectUri || !codeChallenge) {
        sendOAuthError(res, 400, "invalid_request", "Missing required OAuth parameters (client_id, redirect_uri, code_challenge).");
        return;
      }

      // Validate client_id before trusting any other parameters
      const client = await resolveClientId(clientId);
      if (!client) {
        sendOAuthError(res, 400, "invalid_request", "Invalid or expired client_id.");
        return;
      }

      if (authRequest.response_type !== "code") {
        sendOAuthError(res, 400, "unsupported_response_type", "Only response_type=code is supported.");
        return;
      }

      const policy = getAgentAuthPolicy();
      if (requiresPreRegisteredClient(policy) && client.type !== "pre_auth") {
        sendOAuthError(res, 400, "invalid_request", "Invalid or expired client_id.");
        return;
      }

      if (requiresHumanConsent(policy)) {
        const consentParams = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: authRequest.code_challenge_method,
          state: authRequest.state,
          response_type: authRequest.response_type,
          agent_name: client.agentName,
        });
        res.redirect(302, `/approve-agent-access?${consentParams.toString()}`);
        return;
      }

      const code = mintAuthCode(clientId, redirectUri, codeChallenge, authRequest.code_challenge_method);
      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set("code", code);
      if (authRequest.state) redirectTarget.searchParams.set("state", authRequest.state);
      res.redirect(302, redirectTarget.toString());
    } catch (error) {
      next(error);
    }
  });

  // ── Consent approval (POST) ────────────────────────────────

  router.post("/oauth/authorize", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policy = getAgentAuthPolicy();
      if (requiresHumanConsent(policy)) {
        const writer = resolveAuthenticatedWriter(req, { requireExplicitAuth: true });
        if (!writer || writer.type !== "human") {
          sendOAuthError(res, 401, "access_denied", "A signed-in human must approve this agent's access.");
          return;
        }
      }

      const authRequest = OAuthAuthorizationRequest.parseBody(req.body);
      const { client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge } = authRequest;

      if (!clientId || !redirectUri || !codeChallenge) {
        sendOAuthError(res, 400, "invalid_request", "Missing required parameters (client_id, redirect_uri, code_challenge).");
        return;
      }

      const client = await resolveClientId(clientId);
      if (!client) {
        sendOAuthError(res, 400, "invalid_request", "Invalid or expired client_id.");
        return;
      }

      if (requiresPreRegisteredClient(policy) && client.type !== "pre_auth") {
        sendOAuthError(res, 400, "invalid_request", "Invalid or expired client_id.");
        return;
      }

      const code = mintAuthCode(clientId, redirectUri, codeChallenge, authRequest.code_challenge_method);
      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set("code", code);
      if (authRequest.state) redirectTarget.searchParams.set("state", authRequest.state);

      res.redirect(302, redirectTarget.toString());
    } catch (error) {
      next(error);
    }
  });

  // ── Token endpoint ─────────────────────────────────────────

  router.post("/oauth/token", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!checkTokenRateLimit()) {
        const body: OAuthErrorResponse = {
          error: "too_many_requests",
          error_description: "Too many token requests. Try again later.",
        };
        res.status(429).setHeader("Retry-After", "60").json(body);
        return;
      }

      const tokenRequest = OAuthTokenRequest.parse(req.body);
      if ("supported" in tokenRequest) {
        sendOAuthError(res, 400, "unsupported_grant_type", `Unsupported grant_type: ${tokenRequest.grant_type}`);
        return;
      }

      switch (tokenRequest.grant_type) {
        case "authorization_code":
          await handleAuthCodeGrant(tokenRequest, res);
          break;
        case "refresh_token":
          await handleRefreshGrant(tokenRequest, res);
          break;
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}

// ─── Token grant handlers ────────────────────────────────────────

async function handleAuthCodeGrant(request: OAuthAuthorizationCodeTokenRequest, res: Response): Promise<void> {
  const code = request.code;
  const codeVerifier = request.code_verifier;
  const clientId = request.client_id;
  const clientSecret = request.client_secret ?? null;
  const redirectUri = request.redirect_uri;

  if (!code || !codeVerifier) {
    console.warn("oauth token: missing code or code_verifier");
    sendOAuthError(res, 400, "invalid_request", "code and code_verifier are required.");
    return;
  }

  // Validate auth code
  const authCode = validateAuthCode(code);
  if (!authCode) {
    console.warn("oauth token: invalid auth code");
    sendOAuthError(res, 400, "invalid_grant", "Invalid or expired authorization code.");
    return;
  }

  // Verify client_id matches
  if (clientId && clientId !== authCode.client_id) {
    console.warn("oauth token: client_id mismatch");
    sendOAuthError(res, 400, "invalid_grant", "client_id mismatch.");
    return;
  }

  // Verify redirect_uri matches (required per OAuth 2.1 when redirect_uri was in the auth request)
  if (redirectUri && redirectUri !== authCode.redirect_uri) {
    console.warn("oauth token: redirect_uri mismatch");
    sendOAuthError(res, 400, "invalid_grant", "redirect_uri mismatch.");
    return;
  }

  // PKCE verification: SHA256(code_verifier) must equal code_challenge
  const computedChallenge = base64UrlEncode(
    createHash("sha256").update(codeVerifier).digest()
  );

  if (computedChallenge !== authCode.code_challenge) {
    console.warn("oauth token: PKCE failed");
    sendOAuthError(res, 400, "invalid_grant", "PKCE verification failed.");
    return;
  }

  // Resolve client identity and enforce auth method
  const resolvedClientId = authCode.client_id;

  // Try anonymous first
  const anon = validateAnonClientId(resolvedClientId);
  if (anon) {
    if (requiresPreRegisteredClient(getAgentAuthPolicy())) {
      console.warn("oauth token: anonymous client rejected (confidential policy)");
      sendOAuthError(res, 400, "invalid_client", "Anonymous agent identities cannot obtain tokens under the confidential policy. Contact the administrator to register a named agent identity.");
      return;
    }
    // Anonymous client — no secret required. All checks passed; consume the nonce.
    consumeAuthCode(authCode);
    const tokens = issueTokenPair({
      id: anon.agent_id,
      type: "agent",
      displayName: anon.agent_name,
    });
    const response: OAuthTokenResponse = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
    };
    res.json(response);
    return;
  }

  // Try pre-authenticated
  const preAuth = await lookupAgentKey(resolvedClientId);
  if (preAuth) {
    const policy = getAgentAuthPolicy();
    if (requiresClientSecretAtToken(policy)) {
      // confidential: client_secret is mandatory
      if (!clientSecret) {
        console.warn("oauth token: missing client_secret (confidential policy)");
        sendOAuthError(res, 401, "invalid_client", "client_secret is required (policy: confidential).");
        return;
      }
      if (preAuth.secretHash === "none") {
        console.warn("oauth token: agent has no secret hash (confidential policy)");
        sendOAuthError(res, 401, "invalid_client", "Agent was registered without a secret. Rotate or re-register the agent with a secret to use the confidential policy.");
        return;
      }
      const { compareSecret } = await import("../../auth/agent-keys.js");
      const secretValid = await compareSecret(clientSecret, preAuth.secretHash);
      if (!secretValid) {
        console.warn("oauth token: invalid client_secret");
        sendOAuthError(res, 401, "invalid_client", "Invalid client_secret.");
        return;
      }
    }
    // open / approve: client_id in agents.keys is sufficient — issue the token.
    // All checks passed; consume the nonce.
    consumeAuthCode(authCode);
    const tokens = issueTokenPair({
      id: preAuth.agentId,
      type: "agent",
      displayName: preAuth.displayName,
    });
    const response: OAuthTokenResponse = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
    };
    res.json(response);
    return;
  }

  // Unknown client_id
  console.warn("oauth token: unknown client_id");
  sendOAuthError(res, 400, "invalid_client", "Unknown client_id.");
}

async function handleRefreshGrant(request: OAuthRefreshTokenRequest, res: Response): Promise<void> {
  const refreshToken = request.refresh_token;

  if (!refreshToken) {
    console.warn("oauth token: missing refresh_token");
    sendOAuthError(res, 400, "invalid_request", "refresh_token is required.");
    return;
  }

  const { exchangeRefreshToken, InvalidRefreshTokenError } = await import("../../auth/service.js");
  try {
    const tokens = exchangeRefreshToken(refreshToken);
    const response: OAuthTokenResponse = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
    };
    res.json(response);
  } catch (err) {
    // Only an invalid/expired refresh token is a 401 invalid_grant. Any other
    // failure propagates fail-loud to the route's error handler.
    if (err instanceof InvalidRefreshTokenError) {
      console.warn("oauth token: invalid refresh_token");
      sendOAuthError(res, 401, "invalid_grant", err.message);
      return;
    }
    throw err;
  }
}

