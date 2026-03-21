/**
 * Stateless OAuth token primitives — client_id and authorization code.
 *
 * Both are HMAC-SHA256 signed tokens (not JWTs — simpler, purpose-specific).
 * Format: base64url(JSON payload) + "." + base64url(HMAC signature)
 */

import { createHmac, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { getAgentAnonSalt } from "./oauth-config.js";

// ─── Helpers ─────────────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(str: string): Buffer {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  return Buffer.from(normalized + "=".repeat(padLength), "base64");
}

function hmacSign(payload: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(payload).digest();
  return base64UrlEncode(sig);
}

function mintToken(data: Record<string, unknown>, secret: string): string {
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(data), "utf8"));
  const sig = hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

function verifyToken(token: string, secret: string): Record<string, unknown> | null {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx <= 0) return null;
  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expected = hmacSign(payload, secret);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    return JSON.parse(base64UrlDecode(payload).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Anonymous client_id token ───────────────────────────────────

export interface AnonClientIdPayload {
  agent_id: string;
  agent_name: string;
  type: "agent";
  month: string;        // "YYYY-MM"
  token_use: "client_id";
  iat: number;
}

function currentMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function previousMonth(): string {
  const now = new Date();
  now.setUTCMonth(now.getUTCMonth() - 1);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Mint a stateless client_id for an anonymous agent.
 * Signed with KS_AGENT_ANON_SALT.
 */
export function mintAnonClientId(agentName: string): string {
  const data: AnonClientIdPayload = {
    agent_id: `agent-${randomUUID()}`,
    agent_name: agentName,
    type: "agent",
    month: currentMonth(),
    token_use: "client_id",
    iat: Math.floor(Date.now() / 1000),
  };
  return mintToken(data as unknown as Record<string, unknown>, getAgentAnonSalt());
}

/**
 * Validate and decode an anonymous client_id token.
 * Returns the payload if valid, null if invalid or expired.
 */
export function validateAnonClientId(token: string): AnonClientIdPayload | null {
  const data = verifyToken(token, getAgentAnonSalt());
  if (!data) return null;

  // Check required fields
  if (data.token_use !== "client_id") return null;
  if (typeof data.agent_id !== "string") return null;
  if (typeof data.agent_name !== "string") return null;
  if (data.type !== "agent") return null;
  if (typeof data.month !== "string") return null;

  // Month check: current or previous month (1-month grace period)
  const cur = currentMonth();
  const prev = previousMonth();
  if (data.month !== cur && data.month !== prev) return null;

  return data as unknown as AnonClientIdPayload;
}

// ─── Authorization code token ────────────────────────────────────

export interface AuthCodePayload {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  exp: number;
  jti: string;
}

// In-memory nonce dedup set — entries auto-expire after 60s
const usedNonces = new Map<string, number>();

function cleanExpiredNonces(): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(nonce);
  }
}

function getAuthSecret(): string {
  return process.env.KS_AUTH_SECRET ?? "development-insecure-secret";
}

/**
 * Mint a stateless authorization code.
 * Signed with KS_AUTH_SECRET. Expires in 60 seconds.
 */
export function mintAuthCode(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  codeChallengeMethod: string,
): string {
  const data: AuthCodePayload = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    exp: Math.floor(Date.now() / 1000) + 60,
    jti: randomUUID(),
  };
  return mintToken(data as unknown as Record<string, unknown>, getAuthSecret());
}

/**
 * Validate and consume an authorization code.
 * Returns the payload if valid, null if invalid, expired, or already used.
 */
export function validateAuthCode(code: string): AuthCodePayload | null {
  const data = verifyToken(code, getAuthSecret());
  if (!data) return null;

  // Check required fields
  if (typeof data.client_id !== "string") return null;
  if (typeof data.redirect_uri !== "string") return null;
  if (typeof data.code_challenge !== "string") return null;
  if (typeof data.code_challenge_method !== "string") return null;
  if (typeof data.exp !== "number") return null;
  if (typeof data.jti !== "string") return null;

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (data.exp <= now) return null;

  // Nonce dedup
  cleanExpiredNonces();
  if (usedNonces.has(data.jti)) return null;
  usedNonces.set(data.jti, Date.now() + 60_000);

  return data as unknown as AuthCodePayload;
}
