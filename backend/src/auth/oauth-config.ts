/**
 * OAuth configuration — env var handling and startup validation.
 *
 * Env vars:
 *   KS_OIDC_PUBLIC_URL              — explicit public URL override for human OIDC
 *   KS_MCP_PUBLIC_URL               — explicit public URL override for MCP agent OAuth
 *   KS_MCP_PUBLIC_URL_FROM_HEADERS  — derive MCP public URL from trusted request/proxy headers
 *   KS_AUTH_SECRET                  — JWT signing secret (must not be default in non-single-user mode)
 *   KS_AGENT_ANON_SALT              — HMAC key for stateless anonymous client_id tokens
 *   KS_AGENT_AUTH_POLICY            — "open" | "register" | "verify" (default: open for localhost, register otherwise)
 */

import type { Request } from "express";
import { randomBytes } from "node:crypto";
import { isSingleUserMode } from "./context.js";
import { readRuntimeAuthMode } from "./service.js";
import { readEnvVar } from "../env.js";
import { DEFAULT_AUTH_SECRET } from "./encoding.js";

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
  const hostname = readEnvVar("KS_EXTERNAL_HOSTNAME", "localhost");
  const port = readEnvVar("KS_EXTERNAL_PORT", "");
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const scheme = isLocal ? "http" : "https";
  const standardPort = scheme === "https" ? "443" : "80";
  const portSuffix = port && port !== standardPort ? `:${port}` : "";
  return `${scheme}://${hostname}${portSuffix}`;
}

function normalizeConfiguredPublicUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function parseForwardedHeader(forwarded: string): { proto?: string; host?: string } {
  const firstEntry = forwarded.split(",")[0] ?? "";
  const protoMatch = /(?:^|;)\s*proto=([^;,\s]+)/i.exec(firstEntry);
  const hostMatch = /(?:^|;)\s*host="?([^;",\s]+)"?/i.exec(firstEntry);
  return {
    proto: protoMatch?.[1]?.trim(),
    host: hostMatch?.[1]?.trim(),
  };
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function deriveMCPPublicURLFromRequest(req: Request): string | null {
  const forwarded = parseForwardedHeader(String(req.headers.forwarded ?? ""));
  const forwardedHost = firstHeaderValue(req.get("x-forwarded-host") ?? undefined);
  const forwardedPort = firstHeaderValue(req.get("x-forwarded-port") ?? undefined);
  const rawHost = forwarded.host ?? forwardedHost ?? req.get("host") ?? undefined;
  if (!rawHost) return null;

  const hasPortInHost = /^\[.*\](:\d+)?$/.test(rawHost) ? /\]:\d+$/.test(rawHost) : /:\d+$/.test(rawHost);
  const host = !hasPortInHost && forwardedPort ? `${rawHost}:${forwardedPort}` : rawHost;

  const rawProto = firstHeaderValue(forwarded.proto ?? req.get("x-forwarded-proto") ?? undefined);
  const proto = (rawProto ?? "").toLowerCase();
  const scheme = proto === "http" || proto === "https"
    ? proto
    : req.secure
      ? "https"
      : "http";

  return `${scheme}://${host}`.replace(/\/+$/, "");
}

// ─── KS_OIDC_PUBLIC_URL ───────────────────────────────────────────────

/**
 * Get the public URL of this server for OIDC callbacks and auth metadata.
 * Explicit `KS_OIDC_PUBLIC_URL` takes priority; otherwise derived via getPublicUrl().
 */
export function getOidcPublicUrl(): string {
  const explicit = readEnvVar("KS_OIDC_PUBLIC_URL");
  if (explicit) return normalizeConfiguredPublicUrl(explicit);
  return getPublicUrl();
}

// ─── KS_MCP_PUBLIC_URL ────────────────────────────────────────────────

export function isMCPPublicURLFromHeadersEnabled(): boolean {
  return readEnvVar("KS_MCP_PUBLIC_URL_FROM_HEADERS", "").trim().toLowerCase() === "true";
}

/**
 * Get the public URL of this server for MCP agent OAuth metadata.
 * Explicit `KS_MCP_PUBLIC_URL` takes priority unless header-derived mode is enabled.
 * When `KS_MCP_PUBLIC_URL_FROM_HEADERS=true`, the server reflects trusted proxy/request
 * headers when a Request is available; otherwise it falls back to getPublicUrl().
 */
export function getMCPPublicURL(req?: Request): string {
  if (isMCPPublicURLFromHeadersEnabled() && req) {
    const derived = deriveMCPPublicURLFromRequest(req);
    if (derived) return derived;
  }

  const explicit = readEnvVar("KS_MCP_PUBLIC_URL");
  if (explicit) return normalizeConfiguredPublicUrl(explicit);
  return getPublicUrl();
}

// ─── KS_AGENT_ANON_SALT ─────────────────────────────────────────

/**
 * Get the HMAC key for signing anonymous agent client_id tokens.
 * Auto-generated if not set (logged to stdout, not persisted).
 */
export function getAgentAnonSalt(): string {
  if (_anonSalt) return _anonSalt;

  const fromEnv = readEnvVar("KS_AGENT_ANON_SALT");
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
  const val = readEnvVar("KS_AGENT_AUTH_POLICY")?.toLowerCase();
  if (val === "open" || val === "register" || val === "verify") return val;
  const hostname = readEnvVar("KS_EXTERNAL_HOSTNAME", "localhost");
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  return isLocal ? "open" : "register";
}

// ─── OIDC configuration ──────────────────────────────────────────

/**
 * Returns true if both KS_OIDC_ISSUER and KS_OIDC_CLIENT_ID are set.
 */
export function isOidcConfigured(): boolean {
  return !!(readEnvVar("KS_OIDC_ISSUER") && readEnvVar("KS_OIDC_CLIENT_ID"));
}

/**
 * Human-readable display name for the OIDC login button.
 */
export function getOidcDisplayName(): string {
  return readEnvVar("KS_OIDC_DISPLAY_NAME", "Sign in with SSO");
}

// ─── Startup validation ──────────────────────────────────────────

/**
 * Validate OAuth-related configuration at startup.
 * Throws with a FATAL message if misconfigured.
 * Must be called before the server starts listening.
 */
export function validateOAuthConfig(): void {
  // Validate KS_AUTH_MODE early — throws on empty/unrecognised values
  readRuntimeAuthMode();

  const singleUser = isSingleUserMode();

  const explicitOidcPublicUrl = readEnvVar("KS_OIDC_PUBLIC_URL", "");
  const explicitMcpPublicUrl = readEnvVar("KS_MCP_PUBLIC_URL", "");
  const mcpPublicUrlFromHeaders = isMCPPublicURLFromHeadersEnabled();
  const explicitExternalHostname = readEnvVar("KS_EXTERNAL_HOSTNAME", "");

  if (mcpPublicUrlFromHeaders && explicitMcpPublicUrl) {
    throw new Error(
      `FATAL: KS_MCP_PUBLIC_URL_FROM_HEADERS=true is mutually exclusive with KS_MCP_PUBLIC_URL.\n` +
      `Choose exactly one MCP public URL strategy:\n` +
      `- Set KS_MCP_PUBLIC_URL explicitly, OR\n` +
      `- Set KS_MCP_PUBLIC_URL_FROM_HEADERS=true and let the server derive the MCP URL from trusted request/proxy headers.`,
    );
  }

  // Enforced matrix:
  // - single_user is mutually exclusive with explicit OIDC URL and explicit external hostname
  // - non-single-user requires at least one of explicit OIDC URL or explicit external hostname
  if (singleUser) {
    const isLoopback = isLoopbackHostname(explicitExternalHostname);
    if (explicitOidcPublicUrl || (explicitExternalHostname && !isLoopback)) {
      throw new Error(
        `FATAL: KS_AUTH_MODE=single_user is mutually exclusive with KS_OIDC_PUBLIC_URL and KS_EXTERNAL_HOSTNAME.\n` +
        `Remove KS_OIDC_PUBLIC_URL and KS_EXTERNAL_HOSTNAME when running single-user mode.\n` +
        `single_user may be combined with KS_EXTERNAL_PORT only.`,
      );
    }
  } else {
    if (!explicitOidcPublicUrl && !explicitExternalHostname) {
      throw new Error(
        `FATAL: non-single-user mode requires at least one of KS_OIDC_PUBLIC_URL or KS_EXTERNAL_HOSTNAME.\n` +
        `Set KS_OIDC_PUBLIC_URL explicitly, or set KS_EXTERNAL_HOSTNAME and allow OIDC URL derivation.`,
      );
    }
  }

  // KS_EXTERNAL_PORT is always required — bare invocation without compose is not supported
  if (!readEnvVar("KS_EXTERNAL_PORT")) {
    throw new Error(
      `FATAL: KS_EXTERNAL_PORT is not set.\n` +
      `Running the server outside of a compose environment is not a supported mode.\n` +
      `Use docker compose (dev or quickstart) which sets this automatically,\n` +
      `or set KS_EXTERNAL_PORT to the host port users connect on.\n` +
      `Example: KS_EXTERNAL_PORT=8080`,
    );
  }

  // KS_AUTH_SECRET must not be the default in non-single-user mode
  if (!singleUser) {
    const secret = readEnvVar("KS_AUTH_SECRET");
    if (!secret || secret === DEFAULT_AUTH_SECRET) {
      throw new Error(
        `FATAL: KS_AUTH_SECRET must be set to a secure value in non-single-user mode.\n` +
        `The default development secret is not safe for production.\n` +
        `Generate one with: openssl rand -hex 32`,
      );
    }
  }

  // KS_OIDC_ISSUER and KS_OIDC_CLIENT_ID are required in oidc or hybrid mode
  const authMode = readRuntimeAuthMode();
  if (authMode === "oidc" || authMode === "hybrid") {
    if (!readEnvVar("KS_OIDC_ISSUER")) {
      throw new Error(
        `FATAL: KS_OIDC_ISSUER is required when KS_AUTH_MODE is "${authMode}".\n` +
        `Set it to the issuer URL of your OIDC provider.\n` +
        `Example: KS_OIDC_ISSUER=https://accounts.google.com`,
      );
    }
    if (!readEnvVar("KS_OIDC_CLIENT_ID")) {
      throw new Error(
        `FATAL: KS_OIDC_CLIENT_ID is required when KS_AUTH_MODE is "${authMode}".\n` +
        `Set it to the client ID registered with your OIDC provider.`,
      );
    }
  }

  // Eagerly initialize the anon salt (logs if auto-generated)
  getAgentAnonSalt();
}
