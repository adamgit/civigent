import type { Request, Response } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { decodeAndValidateToken, InvalidAuthTokenError, type AuthTokenClaims } from "./tokens.js";
import { isAdmin, getDocReadPermission } from "./acl.js";
import { readEnvVar } from "../env.js";

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
  return (readEnvVar("KS_AUTH_MODE") ?? "").toLowerCase() === "single_user";
}

export function getSingleUserIdentity(): AuthenticatedWriter {
  const defaultName = readEnvVar("KS_USER_NAME", "Local User");
  const defaultEmail = readEnvVar("KS_USER_EMAIL", "local-user@ks.local");
  const defaultId = readEnvVar("KS_USER_ID", "human-ui");
  return {
    id: defaultId,
    type: "human",
    displayName: defaultName,
    email: defaultEmail,
  };
}

export function resolveAuthenticatedWriter(
  req: Request,
  options?: ResolveWriterOptions,
): AuthenticatedWriter | null {
  return resolveAuthenticatedWriterFromHeaders(req.headers, options);
}

export interface ResolveWriterOptions {
  /** When true, skip the single-user fallback — require an explicit token. */
  requireExplicitAuth?: boolean;
}

export interface ResolvedWriter {
  writer: AuthenticatedWriter;
  /** Token expiry (epoch seconds). Infinity for single-user mode (no token). */
  tokenExp: number;
}

export function resolveAuthenticatedWriterFromHeaders(
  headers: IncomingHttpHeaders,
  options?: ResolveWriterOptions,
): AuthenticatedWriter | null {
  return resolveWriterWithExpiry(headers, options)?.writer ?? null;
}

export function resolveWriterWithExpiry(
  headers: IncomingHttpHeaders,
  options?: ResolveWriterOptions,
): ResolvedWriter | null {
  // Always check for a Bearer token first — agents authenticate via Bearer
  // even in single-user mode (where the human has no token).
  const bearerToken = parseBearerTokenFromHeaders(headers);
  if (bearerToken) {
    try {
      const claims = decodeAndValidateToken(bearerToken);
      return { writer: toWriter(claims), tokenExp: claims.exp };
    } catch (error) {
      if (!(error instanceof InvalidAuthTokenError)) {
        throw error;
      }
      // Invalid bearer token — fall through to other auth methods
    }
  }

  if (isSingleUserMode() && !options?.requireExplicitAuth) {
    return { writer: getSingleUserIdentity(), tokenExp: Infinity };
  }

  const cookieToken = parseCookieTokenFromHeaders(headers);
  if (!cookieToken) {
    return null;
  }
  try {
    const claims = decodeAndValidateToken(cookieToken);
    return { writer: toWriter(claims), tokenExp: claims.exp };
  } catch (error) {
    if (error instanceof InvalidAuthTokenError) {
      return null;
    }
    throw error;
  }
}

/**
 * Require the caller to be an authenticated admin.
 * Returns the AuthenticatedWriter on success.
 * Sends 401 if not authenticated, 403 if not admin; returns null in both cases.
 * Agents are never admin — agents never appear in roles.json.
 */
export async function requireAdmin(req: Request, res: Response): Promise<AuthenticatedWriter | null> {
  const writer = resolveAuthenticatedWriter(req);
  if (!writer) {
    res.status(401).json({ message: "Authentication required." });
    return null;
  }
  if (writer.type === "agent") {
    res.status(403).json({ message: "Admin access is not available to agents." });
    return null;
  }
  const admin = await isAdmin(writer.id);
  if (!admin) {
    res.status(403).json({ message: "Admin access required." });
    return null;
  }
  return writer;
}

/**
 * Resolve access for a document read operation.
 *
 * Returns:
 *   - AuthenticatedWriter if the caller is authenticated
 *   - "public" if the document is publicly accessible and the caller is unauthenticated
 *   - null if the caller is not authenticated and the document requires auth (401 sent)
 */
export async function resolvePublicOrAuthenticated(
  req: Request,
  res: Response,
  docPath: string,
): Promise<AuthenticatedWriter | "public" | null> {
  const writer = resolveAuthenticatedWriter(req);
  if (writer) return writer;

  const permission = await getDocReadPermission(docPath);
  if (permission === "public") return "public";

  res.status(401).json({ message: "Authentication required." });
  return null;
}
