/**
 * OAuth configuration — env var handling and startup validation.
 *
 * Env vars:
 *   KS_OIDC_PUBLIC_URL        — public URL of this server (required in non-single-user mode)
 *   KS_AUTH_SECRET        — JWT signing secret (must not be default in non-single-user mode)
 *   KS_AGENT_ANON_SALT    — HMAC key for stateless anonymous client_id tokens
 *   KS_AGENT_ANONYMOUS    — "true"/"false", whether anonymous agent registration is allowed
 */

import { randomBytes } from "node:crypto";
import { isSingleUserMode } from "./context.js";

const DEFAULT_AUTH_SECRET = "development-insecure-secret";

// ─── Lazy-initialized values ─────────────────────────────────────

let _anonSalt: string | null = null;

// ─── KS_OIDC_PUBLIC_URL ───────────────────────────────────────────────

/**
 * Get the public URL of this server that Auth can use for building URLs and for auth (OIDC) callbacks.
 * In single-user mode, defaults to http://localhost:${PORT}.
 * In other modes, must be set explicitly.
 */
export function getOidcPublicUrl(): string {
  const explicit = process.env.KS_OIDC_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  if (isSingleUserMode()) {
    const port = process.env.PORT ?? "3000";
    return `http://localhost:${port}`;
  }

  // Should have been caught by validateOAuthConfig at startup
  throw new Error("KS_OIDC_PUBLIC_URL is not set and server is not in single-user mode.");
}

// ─── KS_AGENT_ANON_SALT ─────────────────────────────────────────

/**
 * Get the HMAC key for signing anonymous agent client_id tokens.
 * Auto-generated if not set (logged to stdout, not persisted).
 */
export function getAgentAnonSalt(): string {
  if (_anonSalt) return _anonSalt;

  const fromEnv = process.env.KS_AGENT_ANON_SALT?.trim();
  if (fromEnv) {
    _anonSalt = fromEnv;
    return _anonSalt;
  }

  _anonSalt = randomBytes(32).toString("hex");
  console.log(
    `KS_AGENT_ANON_SALT not set — auto-generated: ${_anonSalt}\n` +
    `Anonymous agent registrations will not survive restart unless you set this explicitly.`,
  );
  return _anonSalt;
}

// ─── KS_AGENT_ANONYMOUS ─────────────────────────────────────────

/**
 * Whether anonymous (Tier 1) agent registration is allowed.
 * Default: true.
 */
export function isAnonymousAgentEnabled(): boolean {
  const val = process.env.KS_AGENT_ANONYMOUS?.trim().toLowerCase();
  if (val === "false" || val === "0" || val === "no") return false;
  return true;
}

// ─── Startup validation ──────────────────────────────────────────

/**
 * Validate OAuth-related configuration at startup.
 * Throws with a FATAL message if misconfigured.
 * Must be called before the server starts listening.
 */
export function validateOAuthConfig(): void {
  const singleUser = isSingleUserMode();

  // KS_OIDC_PUBLIC_URL is required in non-single-user mode
  if (!singleUser) {
    const publicUrl = process.env.KS_OIDC_PUBLIC_URL?.trim();
    if (!publicUrl) {
      throw new Error(
        `FATAL: KS_OIDC_PUBLIC_URL is required.\n` +
        `The server must know its publicly reachable URL to serve OAuth metadata.\n` +
        `Set it to the URL where agent operators will reach this server.\n` +
        `Example: KS_OIDC_PUBLIC_URL=https://wiki.company.com\n\n` +
        `If running locally for evaluation, use single-user mode instead:\n` +
        `  KS_AUTH_MODE=single_user`,
      );
    }
  }

  // KS_AUTH_SECRET must not be the default in non-single-user mode
  if (!singleUser) {
    const secret = process.env.KS_AUTH_SECRET?.trim();
    if (!secret || secret === DEFAULT_AUTH_SECRET) {
      throw new Error(
        `FATAL: KS_AUTH_SECRET must be set to a secure value in non-single-user mode.\n` +
        `The default development secret is not safe for production.\n` +
        `Generate one with: openssl rand -hex 32`,
      );
    }
  }

  // Eagerly initialize the anon salt (logs if auto-generated)
  getAgentAnonSalt();
}
