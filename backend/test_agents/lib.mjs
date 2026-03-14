/**
 * Shared helpers for agent scripts.
 *
 * Provides HTTP and MCP client wrappers so each agent script
 * stays focused on its task logic.
 *
 * Uses OAuth 2.1 flow for authentication:
 *   1. POST /oauth/register → get client_id
 *   2. Generate PKCE code_verifier + code_challenge
 *   3. POST /oauth/authorize → consent → get auth code from redirect
 *   4. POST /oauth/token → exchange code for access_token
 */

import { createHash, randomBytes } from "node:crypto";

const BASE_URL = process.env.KS_BASE_URL ?? "http://localhost:3000";
const REDIRECT_URI = "http://localhost:0/callback";

// ─── PKCE helpers ─────────────────────────────────────────

function generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// ─── REST helpers ─────────────────────────────────────────

export async function registerAgent(displayName) {
  // Step 1: Dynamic Client Registration
  const regRes = await fetch(`${BASE_URL}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: displayName,
      redirect_uris: [REDIRECT_URI],
    }),
  });
  if (!regRes.ok) {
    throw new Error(`OAuth registration failed: ${regRes.status} ${await regRes.text()}`);
  }
  const regData = await regRes.json();
  const clientId = regData.client_id;

  // Step 2: PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Step 3: Authorization via consent POST (programmatic — follows 302 to extract code)
  const authRes = await fetch(`${BASE_URL}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: "script",
    }).toString(),
    redirect: "manual",
  });

  if (authRes.status !== 302) {
    throw new Error(`OAuth authorize failed: ${authRes.status} ${await authRes.text()}`);
  }

  const location = authRes.headers.get("location");
  const redirectUrl = new URL(location);
  const authCode = redirectUrl.searchParams.get("code");
  if (!authCode) {
    throw new Error(`No auth code in redirect: ${location}`);
  }

  // Step 4: Token exchange
  const tokenRes = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: authCode,
      code_verifier: codeVerifier,
      client_id: clientId,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`OAuth token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokenData = await tokenRes.json();

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    identity: { id: clientId, type: "agent" },
  };
}

export function api(token) {
  async function request(method, path, body) {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) {
      const err = new Error(`API ${method} ${path} → ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    delete: (path) => request("DELETE", path),
  };
}

// ─── MCP helpers ──────────────────────────────────────────

export function mcpClient(token) {
  let sessionId = null;
  let nextId = 1;

  async function send(method, params) {
    const id = nextId++;
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const returnedSessionId = res.headers.get("Mcp-Session-Id");
    if (returnedSessionId) {
      sessionId = returnedSessionId;
    }
    if (res.status === 204) return null;
    const body = await res.json();
    if (body.error) {
      const err = new Error(`MCP error: ${body.error.message}`);
      err.code = body.error.code;
      err.data = body.error.data;
      throw err;
    }
    return body.result;
  }

  return {
    initialize: () =>
      send("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "ks-agent-script", version: "0.1.0" },
      }),
    listTools: () => send("tools/list", {}),
    callTool: (name, args) => send("tools/call", { name, arguments: args }),
    close: () => {
      const headers = { Authorization: `Bearer ${token}` };
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;
      return fetch(`${BASE_URL}/mcp`, { method: "DELETE", headers });
    },
  };
}

// ─── Logging ──────────────────────────────────────────────

export function log(prefix, ...args) {
  console.log(`[${prefix}]`, ...args);
}
