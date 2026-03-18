/**
 * OAuth configuration — env var handling and startup validation.
 *
 * Env vars:
 *   KS_OIDC_PUBLIC_URL        — public URL of this server (required in non-single-user mode)
 *   KS_AUTH_SECRET        — JWT signing secret (must not be default in non-single-user mode)
 *   KS_AGENT_ANON_SALT    — HMAC key for stateless anonymous client_id tokens
 *   KS_AGENT_AUTH_POLICY  — "open" | "register" | "verify" (default: open for localhost, register otherwise)
 */

import { randomBytes } from "node:crypto";
import { isSingleUserMode } from "./context.js";

const DEFAULT_AUTH_SECRET = "development-insecure-secret";

// ─── Lazy-initialized values ─────────────────────────────────────

let _anonSalt: string | null = null;

// ─── KS_EXTERNAL_HOSTNAME / public URL ───────────────────────────

/**
 * Derive the server's public base URL from environment variables.
 *
 * Rules:
 *   - Hostname: `KS_EXTERNAL_HOSTNAME` (default `localhost`)
 *   - Port:     `KS_EXTERNAL_PORT` (required — validated at startup)
 *   - Scheme:   `http` for localhost/127.0.0.1, `https` otherwise
 *   - Port suffix omitted for standard ports (80/443)
 */
export function getPublicUrl(): string {
  const hostname = process.env.KS_EXTERNAL_HOSTNAME?.trim() || "localhost";
  const port = process.env.KS_EXTERNAL_PORT?.trim() || "";
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const scheme = isLocal ? "http" : "https";
  const standardPort = scheme === "https" ? "443" : "80";
  const portSuffix = port && port !== standardPort ? `:${port}` : "";
  return `${scheme}://${hostname}${portSuffix}`;
}

// ─── KS_OIDC_PUBLIC_URL ───────────────────────────────────────────────

/**
 * Get the public URL of this server for OIDC callbacks and auth metadata.
 * Explicit `KS_OIDC_PUBLIC_URL` takes priority; otherwise derived via getPublicUrl().
 * In non-single-user mode, KS_OIDC_PUBLIC_URL must be set explicitly.
 */
export function getOidcPublicUrl(): string {
  const explicit = process.env.KS_OIDC_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  if (isSingleUserMode()) {
    return getPublicUrl();
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

// ─── KS_AGENT_AUTH_POLICY ────────────────────────────────────────

export type AgentAuthPolicy = "open" | "register" | "verify";

/**
 * Get the agent authentication policy.
 * - open:     Anonymous self-registration allowed; any agent can connect.
 * - register: Only pre-registered agents (client_id in agents.keys) can connect.
 * - verify:   Pre-registration required AND client_secret must be presented at token endpoint.
 *
 * Default: "open" for localhost/127.0.0.1, "register" for public hostnames.
 */
export function getAgentAuthPolicy(): AgentAuthPolicy {
  const val = process.env.KS_AGENT_AUTH_POLICY?.trim().toLowerCase();
  if (val === "open" || val === "register" || val === "verify") return val;
  const hostname = process.env.KS_EXTERNAL_HOSTNAME?.trim() || "localhost";
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  return isLocal ? "open" : "register";
}

// ─── Startup validation ──────────────────────────────────────────

/**
 * Validate OAuth-related configuration at startup.
 * Throws with a FATAL message if misconfigured.
 * Must be called before the server starts listening.
 */
export function validateOAuthConfig(): void {
  const singleUser = isSingleUserMode();

  // KS_EXTERNAL_PORT is always required — bare invocation without compose is not supported
  if (!process.env.KS_EXTERNAL_PORT?.trim()) {
    throw new Error(
      `FATAL: KS_EXTERNAL_PORT is not set.\n` +
      `Running the server outside of a compose environment is not a supported mode.\n` +
      `Use docker compose (dev or quickstart) which sets this automatically,\n` +
      `or set KS_EXTERNAL_PORT to the host port users connect on.\n` +
      `Example: KS_EXTERNAL_PORT=8080`,
    );
  }

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
