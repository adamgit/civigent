import { createHash, randomUUID } from "node:crypto";
import { decodeAndValidateToken, InvalidAuthTokenError, issueTokenPair, type IssuedAuthTokenPair } from "./tokens.js";
import { getSingleUserIdentity, isSingleUserMode, type AuthenticatedWriter } from "./context.js";

export interface AgentRegistrationInput {
  name: string;
  description?: string;
}

export interface LoginInput {
  provider: "oidc" | "credentials" | "single_user";
  username?: string;
  password?: string;
  email?: string;
  name?: string;
  issuer?: string;
  subject?: string;
}

function assertNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

type RuntimeAuthMode = "single_user" | "oidc" | "credentials" | "hybrid";

function readRuntimeAuthMode(): RuntimeAuthMode {
  const mode = String(process.env.KS_AUTH_MODE ?? "").trim().toLowerCase();
  if (mode === "single_user") {
    return "single_user";
  }
  if (mode === "oidc") {
    return "oidc";
  }
  if (mode === "credentials" || mode === "builtin") {
    return "credentials";
  }
  return "hybrid";
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
  if (mode === "hybrid") {
    return provider === "credentials" || provider === "oidc";
  }
  if (mode === "single_user") {
    return true;
  }
  return provider === mode;
}

function loginViaCredentials(input: LoginInput): AuthenticatedWriter {
  const username = normalizeNonEmpty(input.username) ?? normalizeNonEmpty(input.email);
  const password = normalizeNonEmpty(input.password);
  if (!username || !password) {
    throw new Error("validation_error: username/email and password are required.");
  }

  const expectedUsername = normalizeNonEmpty(
    process.env.KS_AUTH_CREDENTIALS_USERNAME
    ?? process.env.KS_ADMIN_EMAIL,
  );
  const expectedPassword = normalizeNonEmpty(
    process.env.KS_AUTH_CREDENTIALS_PASSWORD
    ?? process.env.KS_ADMIN_PASSWORD,
  );

  if (!expectedUsername || !expectedPassword) {
    throw new Error(
      "validation_error: credentials provider is not configured; set credentials username/email and password.",
    );
  }

  if (username !== expectedUsername || password !== expectedPassword) {
    throw new Error("unauthorized: invalid credentials.");
  }

  const id = `human-${deterministicUuid(`credentials|${username.toLowerCase()}`)}`;
  const email = normalizeNonEmpty(input.email) ?? (username.includes("@") ? username : undefined);
  return {
    id,
    type: "human",
    displayName: normalizeNonEmpty(input.name) ?? username,
    ...(email ? { email } : {}),
  };
}

function loginViaOidc(input: LoginInput): AuthenticatedWriter {
  const issuer = normalizeNonEmpty(input.issuer);
  const subject = normalizeNonEmpty(input.subject);
  if (!issuer || !subject) {
    throw new Error("validation_error: issuer and subject are required for oidc login.");
  }
  const seed = `${issuer}|${subject}`;
  const id = `human-${deterministicUuid(seed)}`;
  const displayName = normalizeNonEmpty(input.name)
    ?? normalizeNonEmpty(input.username)
    ?? normalizeNonEmpty(input.email)
    ?? subject;
  const email = normalizeNonEmpty(input.email);
  return {
    id,
    type: "human",
    displayName,
    ...(email ? { email } : {}),
  };
}

export function listAuthMethods(): Array<"oidc" | "credentials" | "single_user"> {
  const mode = readRuntimeAuthMode();
  if (mode === "single_user" || isSingleUserMode()) {
    return ["single_user"];
  }
  if (mode === "oidc") {
    return ["oidc"];
  }
  if (mode === "credentials") {
    return ["credentials"];
  }
  return ["credentials", "oidc"];
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

  let identity: AuthenticatedWriter;
  if (input.provider === "credentials") {
    identity = loginViaCredentials(input);
  } else if (input.provider === "oidc") {
    identity = loginViaOidc(input);
  } else {
    throw new Error(`validation_error: provider "${input.provider}" is not available.`);
  }

  const tokenPair = issueTokenPair(identity);
  return {
    token: tokenPair.access_token,
    access_token: tokenPair.access_token,
    refresh_token: tokenPair.refresh_token,
    identity,
  };
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
