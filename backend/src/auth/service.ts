import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decodeAndValidateToken, InvalidAuthTokenError, issueTokenPair, type IssuedAuthTokenPair } from "./tokens.js";
import { getSingleUserIdentity, isSingleUserMode, type AuthenticatedWriter } from "./context.js";
import { hasAnyAdmin, grantAdmin } from "./acl.js";
import { isOidcConfigured } from "./oauth-config.js";
import { readEnvVar } from "../env.js";

export interface AgentRegistrationInput {
  name: string;
  description?: string;
}

export interface LoginInput {
  provider: "single_user";
  email?: string;
  name?: string;
}

function assertNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type RuntimeAuthMode = "single_user" | "oidc" | "hybrid";

const LEGAL_AUTH_MODES: ReadonlySet<string> = new Set(["single_user", "oidc", "hybrid"]);

export function readRuntimeAuthMode(): RuntimeAuthMode {
  const raw = readEnvVar("KS_AUTH_MODE")?.toLowerCase() ?? "";
  if (!raw) {
    throw new Error(
      `FATAL: KS_AUTH_MODE is not set.\n` +
      `You must explicitly choose an auth mode. Legal values: single_user, oidc, hybrid.\n` +
      `  single_user — no login required (personal / evaluation use)\n` +
      `  oidc        — OIDC provider only\n` +
      `  hybrid      — OIDC + local credentials fallback\n` +
      `Example: KS_AUTH_MODE=single_user`,
    );
  }
  if (!LEGAL_AUTH_MODES.has(raw)) {
    throw new Error(
      `FATAL: KS_AUTH_MODE="${raw}" is not a recognised auth mode.\n` +
      `Legal values: single_user, oidc, hybrid.`,
    );
  }
  return raw as RuntimeAuthMode;
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  if (!assertNonEmptyString(value)) {
    return undefined;
  }
  return value.trim();
}

function providerAllowedInMode(provider: LoginInput["provider"], mode: RuntimeAuthMode): boolean {
  if (mode === "single_user") {
    return true;
  }
  // oidc and hybrid: human login via POST is not used (OIDC redirects handle it)
  return false;
}

/**
 * Build an AuthenticatedWriter identity from OIDC token claims.
 * The deterministic UUID seed is "issuer|subject" — stable across sessions.
 */
export function buildOidcIdentity(
  issuer: string,
  subject: string,
  email?: string,
  name?: string,
): AuthenticatedWriter {
  const id = `human-${deterministicUuid(`${issuer}|${subject}`)}`;
  const displayName = name ?? email ?? subject;
  return {
    id,
    type: "human",
    displayName,
    ...(email ? { email } : {}),
  };
}

export function listAuthMethods(): Array<"oidc" | "single_user"> {
  const mode = readRuntimeAuthMode();
  if (mode === "single_user" || isSingleUserMode()) {
    return ["single_user"];
  }
  // Both oidc and hybrid use OIDC login
  return ["oidc"];
}

export function registerTransientAgent(input: AgentRegistrationInput): {
  token: string;
  access_token: string;
  refresh_token: string;
  identity: AuthenticatedWriter;
} {
  if (!assertNonEmptyString(input.name)) {
    throw new Error("validation_error: agent name is required.");
  }
  const displayName = input.name.trim();
  const description = normalizeNonEmpty(input.description);
  const identity: AuthenticatedWriter = {
    id: `agent-${randomUUID()}`,
    type: "agent",
    displayName,
  };
  const tokenPair = issueTokenPair({
    ...identity,
    ...(description ? { description } : {}),
  });
  return {
    token: tokenPair.access_token,
    access_token: tokenPair.access_token,
    refresh_token: tokenPair.refresh_token,
    identity,
  };
}

export function loginHuman(input: LoginInput): {
  token: string;
  access_token: string;
  refresh_token: string;
  identity: AuthenticatedWriter;
} {
  if (isSingleUserMode()) {
    const identity = getSingleUserIdentity();
    const tokenPair = issueTokenPair(identity);
    return {
      token: tokenPair.access_token,
      access_token: tokenPair.access_token,
      refresh_token: tokenPair.refresh_token,
      identity,
    };
  }

  const mode = readRuntimeAuthMode();
  if (!providerAllowedInMode(input.provider, mode)) {
    throw new Error(
      `validation_error: provider "${input.provider}" is not enabled in auth mode "${mode}".`,
    );
  }

  // Only single_user provider reaches here; OIDC login is handled via redirect flow
  throw new Error(`validation_error: provider "${input.provider}" is not available via POST login.`);
}

// ─── Admin bootstrap (one-time code printed to stdout) ────────────────────────

let _bootstrapCode: string | null = null;
let _bootstrapTimer: ReturnType<typeof setTimeout> | null = null;

const BOOTSTRAP_TTL_MS = 30_000; // 30 seconds

/**
 * If OIDC is configured and no admin users exist in roles.json, generate a
 * one-time bootstrap code and print it to stdout. Called once at startup.
 * Code expires after 30 seconds — restart server to generate a new one.
 */
export async function maybeGenerateBootstrapCode(): Promise<void> {
  if (isSingleUserMode()) return;
  if (!isOidcConfigured()) return;
  if (await hasAnyAdmin()) return;

  _bootstrapCode = randomBytes(16).toString("hex");
  console.log(
    `\n╔══════════════════════════════════════════════════════════════════╗\n` +
    `║  No admin users configured.                                    ║\n` +
    `║  After OIDC login, use this one-time code to claim admin:      ║\n` +
    `║  Code expires in 30 seconds.                                   ║\n` +
    `║                                                                ║\n` +
    `║    ${_bootstrapCode}    ║\n` +
    `║                                                                ║\n` +
    `╚══════════════════════════════════════════════════════════════════╝\n`,
  );

  _bootstrapTimer = setTimeout(() => {
    _bootstrapCode = null;
    _bootstrapTimer = null;
    console.log(
      `\n╔══════════════════════════════════════════════════════════════════╗\n` +
      `║  Bootstrap code expired. Restart server to generate a new one. ║\n` +
      `╚══════════════════════════════════════════════════════════════════╝\n`,
    );
  }, BOOTSTRAP_TTL_MS);
  // Don't let the timer prevent process exit
  _bootstrapTimer.unref();
}

/**
 * Returns true if bootstrap is available (code generated but not yet used or expired).
 */
export function isBootstrapAvailable(): boolean {
  return _bootstrapCode !== null;
}

/**
 * Validate the bootstrap code and grant admin to the given writer.
 * Returns true on success, throws on failure. One-use: code is invalidated after success.
 */
export async function redeemBootstrapCode(code: string, writerId: string): Promise<void> {
  if (!_bootstrapCode) {
    throw new Error("Bootstrap is not available — either already used, expired, or no bootstrap code was generated.");
  }
  if (code !== _bootstrapCode) {
    throw new Error("Invalid bootstrap code.");
  }
  await grantAdmin(writerId);
  _bootstrapCode = null;
  if (_bootstrapTimer) {
    clearTimeout(_bootstrapTimer);
    _bootstrapTimer = null;
  }
  console.log(`Bootstrap code redeemed by writer ${writerId}. Code is now invalid.`);
}

/** For testing only — reset bootstrap state. */
export function _resetBootstrapState(): void {
  _bootstrapCode = null;
  if (_bootstrapTimer) {
    clearTimeout(_bootstrapTimer);
    _bootstrapTimer = null;
  }
}

/** For testing only — set the bootstrap code directly. */
export function _setBootstrapCode(code: string | null): void {
  _bootstrapCode = code;
}

export function exchangeRefreshToken(refreshToken: string): IssuedAuthTokenPair {
  let claims;
  try {
    claims = decodeAndValidateToken(refreshToken);
  } catch (error) {
    if (error instanceof InvalidAuthTokenError) {
      throw new Error("unauthorized: invalid refresh token.");
    }
    throw error;
  }
  if (claims.token_use !== "refresh") {
    throw new Error("unauthorized: invalid refresh token.");
  }
  return issueTokenPair({
    id: claims.sub,
    type: claims.type,
    displayName: claims.display_name,
    ...(claims.description ? { description: claims.description } : {}),
    ...(claims.email ? { email: claims.email } : {}),
  });
}
