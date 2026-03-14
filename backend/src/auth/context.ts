import type { Request } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { decodeAndValidateToken, InvalidAuthTokenError, type AuthTokenClaims } from "./tokens.js";

export interface AuthenticatedWriter {
  id: string;
  type: "human" | "agent";
  displayName: string;
  email?: string;
}

function parseBearerTokenFromHeaders(headers: IncomingHttpHeaders): string | null {
  const rawAuthorization = headers.authorization;
  if (typeof rawAuthorization !== "string" || rawAuthorization.trim().length === 0) {
    return null;
  }
  const [scheme, token] = rawAuthorization.trim().split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

function parseCookieTokenFromHeaders(headers: IncomingHttpHeaders): string | null {
  const rawCookie = headers.cookie;
  if (typeof rawCookie !== "string" || rawCookie.trim().length === 0) {
    return null;
  }
  const parts = rawCookie.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (!part.startsWith("ks_access_token=")) {
      continue;
    }
    const value = part.slice("ks_access_token=".length).trim();
    if (!value) {
      return null;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function toWriter(claims: AuthTokenClaims): AuthenticatedWriter {
  return {
    id: claims.sub,
    type: claims.type,
    displayName: claims.display_name,
    ...(claims.email ? { email: claims.email } : {}),
  };
}

export function isSingleUserMode(): boolean {
  return String(process.env.KS_AUTH_MODE ?? "").toLowerCase() === "single_user";
}

export function getSingleUserIdentity(): AuthenticatedWriter {
  const defaultName = process.env.KS_USER_NAME?.trim() || "Local User";
  const defaultEmail = process.env.KS_USER_EMAIL?.trim() || "local-user@ks.local";
  const defaultId = process.env.KS_USER_ID?.trim() || "human-ui";
  return {
    id: defaultId,
    type: "human",
    displayName: defaultName,
    email: defaultEmail,
  };
}

export function resolveAuthenticatedWriter(req: Request): AuthenticatedWriter | null {
  return resolveAuthenticatedWriterFromHeaders(req.headers);
}

export function resolveAuthenticatedWriterFromHeaders(
  headers: IncomingHttpHeaders,
): AuthenticatedWriter | null {
  // Always check for a Bearer token first — agents authenticate via Bearer
  // even in single-user mode (where the human has no token).
  const bearerToken = parseBearerTokenFromHeaders(headers);
  if (bearerToken) {
    try {
      const claims = decodeAndValidateToken(bearerToken);
      return toWriter(claims);
    } catch (error) {
      if (!(error instanceof InvalidAuthTokenError)) {
        throw error;
      }
      // Invalid bearer token — fall through to other auth methods
    }
  }

  if (isSingleUserMode()) {
    return getSingleUserIdentity();
  }

  const cookieToken = parseCookieTokenFromHeaders(headers);
  if (!cookieToken) {
    return null;
  }
  try {
    const claims = decodeAndValidateToken(cookieToken);
    return toWriter(claims);
  } catch (error) {
    if (error instanceof InvalidAuthTokenError) {
      return null;
    }
    throw error;
  }
}
