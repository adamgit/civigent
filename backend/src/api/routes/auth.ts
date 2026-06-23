import { type Request, type Response, type Router } from "express";
import type { AuthMethod, SessionInfoResponse } from "../../types/shared.js";
import { resolveAuthenticatedWriter } from "../../auth/context.js";
import { listAuthMethods, buildOidcIdentity, isBootstrapAvailable, redeemBootstrapCode, exchangeRefreshToken } from "../../auth/service.js";
import { issueTokenPair } from "../../auth/tokens.js";
import { isOidcConfigured, getOidcDisplayName, getOidcPublicUrl } from "../../auth/oauth-config.js";
import { generateOidcState, generateOidcNonce, storeOidcState, retrieveAndClearOidcState } from "../../auth/oidc-state.js";
import { buildOidcRedirectUrl, redeemOidcCode } from "../../auth/oidc-provider.js";
import { sendApiError } from "./middleware.js";
import { QueryParamError, optionalStringParam } from "../helpers/query-params.js";
import { fileURLToPath } from "node:url";
import { readFileIfExists } from "../../storage/fs-primitives.js";

const BUILD_INFO_FILE_URL = new URL("../../../build-info.json", import.meta.url);

/**
 * Sanitize a return_to URL to prevent open redirect attacks.
 * Uses URL parser (OWASP-recommended) instead of string prefix checks.
 */
export function sanitizeReturnTo(raw: string): string {
  if (!raw || typeof raw !== "string") return "/";
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "");
  try {
    const parsed = new URL(cleaned, "http://localhost");
    if (parsed.hostname !== "localhost") return "/";
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return "/";
  }
}

function authCookieAttributes(req: Request): { secure: boolean } {
  const forwarded = String(req.headers.forwarded ?? "");
  const forwardedProtoMatch = /proto=([^;,\s]+)/i.exec(forwarded);
  const forwardedProto = (forwardedProtoMatch?.[1] ?? "").toLowerCase();
  const secure = req.secure || forwardedProto === "https";
  return { secure };
}

function setAuthCookies(req: Request, res: Response, accessToken: string, refreshToken: string): void {
  const { secure } = authCookieAttributes(req);
  const secureFlag = secure ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `ks_access_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=1800`,
  );
  res.append(
    "Set-Cookie",
    `ks_refresh_token=${encodeURIComponent(refreshToken)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=2592000`,
  );
}

function clearAuthCookies(req: Request, res: Response): void {
  const { secure } = authCookieAttributes(req);
  const secureFlag = secure ? "; Secure" : "";
  res.append("Set-Cookie", `ks_access_token=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`);
  res.append("Set-Cookie", `ks_refresh_token=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`);
}

export function registerAuthRoutes(router: Router): void {
  router.get("/build-info", async (_req, res, next) => {
    try {
      const raw = await readFileIfExists(fileURLToPath(BUILD_INFO_FILE_URL));
      if (raw === null) {
        sendApiError(res, 404, "build-info.json is not available on this server.");
        return;
      }
      const parsed = JSON.parse(raw);
      const version = typeof parsed?.version === "string" ? parsed.version : null;
      const sha = typeof parsed?.sha === "string" ? parsed.sha : null;
      const date = typeof parsed?.date === "string" ? parsed.date : null;
      if (!version || !sha || !date) {
        sendApiError(res, 500, "build-info.json is malformed. Expected { version, sha, date } strings.");
        return;
      }
      res.status(200).json({ version, sha, date });
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/methods", async (_req, res, next) => {
    try {
      const rawMethods = listAuthMethods();
      const methods: AuthMethod[] = rawMethods.map((m) => {
        if (m === "oidc") {
          return { type: "oidc", displayName: getOidcDisplayName(), authUrl: "/api/auth/oidc/authorize" };
        }
        return { type: "single_user", displayName: "Single-user session" };
      });
      res.json({ methods, bootstrap_available: isBootstrapAvailable() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/oidc/authorize", async (req, res, next) => {
    try {
      if (!isOidcConfigured()) {
        sendApiError(res, 503, "OIDC is not configured on this server.");
        return;
      }
      const returnTo = sanitizeReturnTo(optionalStringParam(req.query.return_to, "return_to") ?? "");

      const state = generateOidcState();
      const nonce = generateOidcNonce();
      storeOidcState(state, nonce, returnTo);

      let url: string;
      try {
        url = await buildOidcRedirectUrl(state, nonce);
      } catch (err) {
        sendApiError(res, 503, err instanceof Error ? err : String(err));
        return;
      }
      res.redirect(302, url);
    } catch (error) {
      if (error instanceof QueryParamError) {
        sendApiError(res, 400, error);
        return;
      }
      next(error);
    }
  });

  router.get("/auth/oidc/callback", async (req, res, next) => {
    try {
      const { code, state } = req.query;
      if (!code || !state) {
        sendApiError(res, 400, "Missing code or state in OIDC callback.");
        return;
      }

      const stored = retrieveAndClearOidcState(String(state));
      if (!stored) {
        sendApiError(res, 400, "OIDC state expired or invalid.");
        return;
      }

      const callbackUrl = new URL(req.originalUrl, getOidcPublicUrl());
      let claims: { issuer: string; subject: string; email?: string; name?: string };
      try {
        claims = await redeemOidcCode(callbackUrl, String(state), stored.nonce);
      } catch (err) {
        sendApiError(res, 401, err instanceof Error ? err : String(err));
        return;
      }

      const identity = buildOidcIdentity(claims.issuer, claims.subject, claims.email, claims.name);
      const { access_token, refresh_token } = issueTokenPair(identity);
      setAuthCookies(req, res, access_token, refresh_token);
      res.redirect(302, stored.returnTo);
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/session", (req, res) => {
    const writer = resolveAuthenticatedWriter(req);
    const response: SessionInfoResponse = writer
      ? {
          authenticated: true,
          user: {
            id: writer.id,
            type: writer.type,
            displayName: writer.displayName,
            email: writer.email,
          },
        }
      : { authenticated: false };
    res.json(response);
  });

  router.post("/auth/bootstrap", async (req, res, next) => {
    try {
      const writer = resolveAuthenticatedWriter(req);
      if (!writer) {
        sendApiError(res, 401, "You must be authenticated (via OIDC) before using the bootstrap code.");
        return;
      }
      const { code } = req.body ?? {};
      if (!code) {
        sendApiError(res, 400, "Bootstrap code is required.");
        return;
      }
      await redeemBootstrapCode(String(code), writer.id);
      res.json({ success: true, message: "Admin role granted." });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid bootstrap code")) {
        sendApiError(res, 403, error.message);
        return;
      }
      if (error instanceof Error && error.message.includes("not available")) {
        sendApiError(res, 410, error.message);
        return;
      }
      next(error);
    }
  });

  router.post("/auth/token/refresh", (req, res) => {
    const rawCookie = req.headers.cookie;
    let refreshToken: string | null = null;
    if (typeof rawCookie === "string") {
      for (const part of rawCookie.split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith("ks_refresh_token=")) {
          const raw = trimmed.slice("ks_refresh_token=".length);
          try { refreshToken = decodeURIComponent(raw); } catch { refreshToken = raw; }
          break;
        }
      }
    }
    if (!refreshToken) {
      clearAuthCookies(req, res);
      res.status(401).json({ authenticated: false });
      return;
    }
    try {
      const { access_token, refresh_token } = exchangeRefreshToken(refreshToken);
      setAuthCookies(req, res, access_token, refresh_token);
      res.json({ authenticated: true });
    } catch {
      clearAuthCookies(req, res);
      res.status(401).json({ authenticated: false });
    }
  });

  router.post("/auth/logout", (req, res) => {
    clearAuthCookies(req, res);
    res.json({ success: true });
  });
}
