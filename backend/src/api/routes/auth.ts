import { type Request, type Response, type Router } from "express";
import type { AuthMethod, SessionInfoResponse } from "../../types/shared.js";
import { DocPath } from "../../types/shared.js";
import { isSingleUserMode, resolveAuthenticatedWriter } from "../../auth/context.js";
import { isAdmin } from "../../auth/acl.js";
import { listAuthMethods, buildOidcIdentity, isBootstrapAvailable, redeemBootstrapCode, exchangeRefreshToken, loginHuman, InvalidCredentialsError, redeemShareGrant, InvalidShareGrantError } from "../../auth/service.js";
import { issueTokenPair } from "../../auth/tokens.js";
import { isOidcConfigured, getOidcDisplayName, getOidcPublicUrl, getPublicUrl } from "../../auth/oauth-config.js";
import { mintShareGrant } from "../../auth/share-grants.js";
import { getAppName } from "../../app-name.js";
import { generateOidcState, generateOidcNonce, storeOidcState, retrieveAndClearOidcState } from "../../auth/oidc-state.js";
import { buildOidcRedirectUrl, redeemOidcCode } from "../../auth/oidc-provider.js";
import {
  sendApiError,
  requireAuthenticatedWriter,
  refuseScopedWriter,
  requireDocWritePermission,
} from "./middleware.js";
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

function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
  refreshMaxAgeSeconds: number = 2592000,
): void {
  const { secure } = authCookieAttributes(req);
  const secureFlag = secure ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `ks_access_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=1800`,
  );
  res.append(
    "Set-Cookie",
    `ks_refresh_token=${encodeURIComponent(refreshToken)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=${refreshMaxAgeSeconds}`,
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
      const methods: AuthMethod[] = rawMethods.map((m): AuthMethod => {
        if (m === "oidc") {
          return { type: "oidc", displayName: getOidcDisplayName(), authUrl: "/api/auth/oidc/authorize" };
        }
        if (m === "credentials") {
          return { type: "credentials", displayName: "Shared password" };
        }
        return { type: "single_user", displayName: "Single-user session" };
      });
      res.json({ methods, bootstrap_available: isBootstrapAvailable() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/login", (req, res, next) => {
    try {
      const { provider, password } = req.body ?? {};
      if (provider !== "single_user" && provider !== "credentials") {
        sendApiError(res, 400, `Unknown login provider: ${JSON.stringify(provider ?? null)}.`);
        return;
      }
      const result = loginHuman({
        provider,
        ...(typeof password === "string" ? { password } : {}),
      });
      setAuthCookies(req, res, result.access_token, result.refresh_token);
      res.json(result);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        sendApiError(res, 401, error.message);
        return;
      }
      if (error instanceof Error && error.message.startsWith("validation_error:")) {
        sendApiError(res, 400, error.message);
        return;
      }
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
      let claims: Awaited<ReturnType<typeof redeemOidcCode>>;
      try {
        claims = await redeemOidcCode(callbackUrl, String(state), stored.nonce);
      } catch (err) {
        sendApiError(res, 401, err instanceof Error ? err : String(err));
        return;
      }

      const identity = buildOidcIdentity(claims);
      const { access_token, refresh_token } = issueTokenPair(identity);
      setAuthCookies(req, res, access_token, refresh_token);
      res.redirect(302, stored.returnTo);
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/session", async (req, res, next) => {
    try {
      const writer = resolveAuthenticatedWriter(req);
      const app_name = getAppName();
      const single_user = isSingleUserMode();
      const response: SessionInfoResponse = writer
        ? {
            authenticated: true,
            app_name,
            single_user,
            user: {
              id: writer.id,
              type: writer.type,
              displayName: writer.displayName,
              email: writer.email,
              is_admin: writer.type !== "agent" && (await isAdmin(writer.id)),
              ...(writer.scope
                ? {
                    auth_source: "share" as const,
                    scope_doc: writer.scope.docPath,
                    scope_action: writer.scope.action,
                  }
                : {}),
            },
          }
        : { authenticated: false, app_name, single_user };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/bootstrap", async (req, res, next) => {
    try {
      const writer = resolveAuthenticatedWriter(req);
      if (!writer) {
        sendApiError(res, 401, "You must be authenticated (via OIDC) before using the bootstrap code.");
        return;
      }
      if (refuseScopedWriter(writer, res)) return;
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

  router.post("/auth/share", async (req, res, next) => {
    try {
      const writer = requireAuthenticatedWriter(req, res);
      if (!writer) return;
      if (refuseScopedWriter(writer, res)) return;
      if (writer.type === "agent") {
        sendApiError(res, 403, "Share links are not available to agents.");
        return;
      }
      if (isSingleUserMode()) {
        sendApiError(res, 400, "Share links are not available in single-user mode.");
        return;
      }
      const { doc_path, action, expires_in_days } = req.body ?? {};
      if (typeof doc_path !== "string" || doc_path.length === 0) {
        sendApiError(res, 400, "doc_path is required.");
        return;
      }
      if (action !== "read" && action !== "write") {
        sendApiError(res, 400, 'action must be "read" or "write".');
        return;
      }
      if (expires_in_days !== 1 && expires_in_days !== 7 && expires_in_days !== "never") {
        sendApiError(res, 400, 'expires_in_days must be 1, 7, or "never".');
        return;
      }
      let docPath: DocPath;
      try {
        docPath = DocPath.parse(doc_path);
      } catch (error) {
        sendApiError(res, 400, error instanceof Error ? error.message : String(error));
        return;
      }
      const permitted = await requireDocWritePermission(req, res, docPath);
      if (!permitted) return;

      const { token, exp } = mintShareGrant({
        docPath,
        action,
        expiry: expires_in_days,
        issuedBy: writer.id,
      });
      res.json({ url: `${getPublicUrl()}/share/${token}`, exp });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/share/redeem", (req, res, next) => {
    try {
      const { token, name } = req.body ?? {};
      if (typeof token !== "string" || token.length === 0) {
        sendApiError(res, 400, "token is required.");
        return;
      }
      const result = redeemShareGrant(token, typeof name === "string" ? name : undefined);
      const refreshMaxAge = Math.max(0, result.grant_exp - Math.floor(Date.now() / 1000));
      setAuthCookies(req, res, result.access_token, result.refresh_token, refreshMaxAge);
      res.json({ doc_path: result.doc_path, display_name: result.display_name });
    } catch (error) {
      if (error instanceof InvalidShareGrantError) {
        sendApiError(res, 401, error.message);
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
