import { createHmac, randomUUID } from "node:crypto";

type TokenUse = "access" | "refresh" | "bootstrap";

export interface AuthTokenClaims {
  sub: string;
  type: "human" | "agent";
  display_name: string;
  description?: string;
  email?: string;
  token_use: TokenUse;
  exp: number;
  iat: number;
  jti: string;
}

const DEFAULT_SECRET = "development-insecure-secret";
const ACCESS_TTL_SECONDS = Number(process.env.KS_AUTH_ACCESS_TTL_SECONDS ?? "1800");
const REFRESH_TTL_SECONDS = Number(process.env.KS_AUTH_REFRESH_TTL_SECONDS ?? "2592000");
const BOOTSTRAP_TTL_SECONDS = Number(process.env.KS_AUTH_BOOTSTRAP_TTL_SECONDS ?? "2592000");

function getAuthSecret(): string {
  return process.env.KS_AUTH_SECRET ?? DEFAULT_SECRET;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  const padded = normalized + "=".repeat(padLength);
  return Buffer.from(padded, "base64").toString("utf8");
}

function signValue(value: string): string {
  return createHmac("sha256", getAuthSecret())
    .update(value)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeToken(claims: AuthTokenClaims): string {
  const header = { alg: "HS256", typ: "JWT" };
  const headerPart = base64UrlEncode(JSON.stringify(header));
  const payloadPart = base64UrlEncode(JSON.stringify(claims));
  const signature = signValue(`${headerPart}.${payloadPart}`);
  return `${headerPart}.${payloadPart}.${signature}`;
}

export class InvalidAuthTokenError extends Error {}

export function decodeAndValidateToken(token: string): AuthTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new InvalidAuthTokenError("Malformed token.");
  }
  const [headerPart, payloadPart, providedSignature] = parts;
  const expectedSignature = signValue(`${headerPart}.${payloadPart}`);
  if (providedSignature !== expectedSignature) {
    throw new InvalidAuthTokenError("Invalid token signature.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart));
  } catch {
    throw new InvalidAuthTokenError("Invalid token payload.");
  }

  if (
    typeof payload !== "object"
    || payload == null
    || typeof (payload as { sub?: unknown }).sub !== "string"
    || typeof (payload as { type?: unknown }).type !== "string"
    || typeof (payload as { display_name?: unknown }).display_name !== "string"
    || typeof (payload as { token_use?: unknown }).token_use !== "string"
    || typeof (payload as { exp?: unknown }).exp !== "number"
    || typeof (payload as { iat?: unknown }).iat !== "number"
    || typeof (payload as { jti?: unknown }).jti !== "string"
  ) {
    throw new InvalidAuthTokenError("Invalid token claims.");
  }

  const claims = payload as AuthTokenClaims;
  if (claims.type !== "human" && claims.type !== "agent") {
    throw new InvalidAuthTokenError("Invalid writer type claim.");
  }
  if (claims.token_use !== "access" && claims.token_use !== "refresh" && claims.token_use !== "bootstrap") {
    throw new InvalidAuthTokenError("Invalid token use claim.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (claims.exp <= nowSeconds) {
    throw new InvalidAuthTokenError("Token expired.");
  }
  return claims;
}

function issueToken(
  identity: { id: string; type: "human" | "agent"; displayName: string; description?: string; email?: string },
  tokenUse: TokenUse,
  ttlSeconds: number,
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: AuthTokenClaims = {
    sub: identity.id,
    type: identity.type,
    display_name: identity.displayName,
    ...(identity.description ? { description: identity.description } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    token_use: tokenUse,
    iat: nowSeconds,
    exp: nowSeconds + Math.max(60, ttlSeconds),
    jti: randomUUID(),
  };
  return encodeToken(claims);
}

export interface IssuedAuthTokenPair {
  access_token: string;
  refresh_token: string;
}

export function issueTokenPair(identity: {
  id: string;
  type: "human" | "agent";
  displayName: string;
  description?: string;
  email?: string;
}): IssuedAuthTokenPair {
  return {
    access_token: issueToken(identity, "access", ACCESS_TTL_SECONDS),
    refresh_token: issueToken(identity, "refresh", REFRESH_TTL_SECONDS),
  };
}

export function issueBootstrapToken(identity: {
  id: string;
  type: "human" | "agent";
  displayName: string;
  description?: string;
  email?: string;
}): string {
  return issueToken(identity, "bootstrap", BOOTSTRAP_TTL_SECONDS);
}
