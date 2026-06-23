/**
 * OAuth 2.1 protocol types for the MCP-agent authorization-server path ONLY.
 *
 * These types are intentionally local and SEPARATE from the human OIDC path
 * (`oauth-config.ts` / `oidc-*.ts` / `openid-client`). The available packages are
 * not a clean fit for this server-side surface: `oauth4webapi` is client-oriented,
 * `@jmondi/oauth2-server` / `@node-oauth/oauth2-server` are full framework servers,
 * and `@types/oauth2-server` exposes `any` request-body surfaces. So we model the
 * exact wire shapes this server speaks and validate them at the route boundary,
 * with no `as` / `unknown` / `any`.
 *
 * Request contracts ship a companion `.parse(...)` (and `.parseQuery(...)` /
 * `.parseBody(...)` where a request arrives both ways). Extraction is LENIENT in
 * the OAuth style — a missing or wrong-typed field becomes its protocol default or
 * an empty value, and the route then enforces required fields with the appropriate
 * OAuth JSON error (`{ error, error_description }`). A non-object body yields an
 * all-empty contract (→ the route's `invalid_request` / `unsupported_grant_type`).
 */
import type { Request } from "express";
import { type JsonObject, type JsonValue } from "../types/shared.js";

// ─── Protocol scalar unions ──────────────────────────────────────────

/** Grant types this authorization server supports at the token endpoint. */
export type OAuthGrantType = "authorization_code" | "refresh_token";

/** Response types this authorization server supports at the authorize endpoint. */
export type OAuthResponseType = "code";

/** PKCE code-challenge methods. */
export type OAuthCodeChallengeMethod = "S256" | "plain";

/** Token-endpoint client authentication methods. */
export type OAuthTokenEndpointAuthMethod = "none" | "client_secret_post";

/** Default PKCE method when a request omits `code_challenge_method`. */
const DEFAULT_CODE_CHALLENGE_METHOD: OAuthCodeChallengeMethod = "S256";

// ─── Lenient JSON-field extraction helpers ───────────────────────────

/** Local array guard — `Array.isArray` does not narrow a `readonly JsonValue[]` union member. */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** A non-object JSON value carries no usable fields → treat as an empty record. */
function recordOf(value: JsonValue): JsonObject {
  if (typeof value !== "object" || value === null || isJsonArray(value)) {
    return {};
  }
  return value;
}

function stringFieldOrUndefined(obj: JsonObject, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function stringFieldOr(obj: JsonObject, key: string, fallback: string): string {
  return stringFieldOrUndefined(obj, key) ?? fallback;
}

function stringArrayField(obj: JsonObject, key: string, fallback: string[]): string[] {
  const value = obj[key];
  if (!isJsonArray(value)) return fallback;
  return value.filter((element): element is string => typeof element === "string");
}

/** Read a single string query value; arrays/objects/absence collapse to `fallback`. */
function queryStringOr(query: Request["query"], key: string, fallback: string): string {
  const value = query[key];
  return typeof value === "string" ? value : fallback;
}

// ─── DCR (RFC 7591) ──────────────────────────────────────────────────

/** Body of `POST /oauth/register` — Dynamic Client Registration. */
export interface OAuthDynamicClientRegistrationRequest {
  client_name?: string;
  client_secret?: string;
  redirect_uris: string[];
  grant_types: string[];
}

export const OAuthDynamicClientRegistrationRequest = {
  parse(value: JsonValue): OAuthDynamicClientRegistrationRequest {
    const obj = recordOf(value);
    const request: OAuthDynamicClientRegistrationRequest = {
      redirect_uris: stringArrayField(obj, "redirect_uris", []),
      grant_types: stringArrayField(obj, "grant_types", ["authorization_code"]),
    };
    const clientName = stringFieldOrUndefined(obj, "client_name");
    if (clientName !== undefined) request.client_name = clientName;
    const clientSecret = stringFieldOrUndefined(obj, "client_secret");
    if (clientSecret !== undefined) request.client_secret = clientSecret;
    return request;
  },
};

// ─── Authorization request (RFC 6749 §4.1.1 + PKCE) ──────────────────

/**
 * The `/oauth/authorize` request, arriving either as a query (GET) or a form body
 * (POST). `response_type` is only meaningful on the GET path; it defaults to
 * `"code"` so a single shape serves both.
 */
export interface OAuthAuthorizationRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  response_type: string;
}

export const OAuthAuthorizationRequest = {
  parseQuery(query: Request["query"]): OAuthAuthorizationRequest {
    return {
      client_id: queryStringOr(query, "client_id", ""),
      redirect_uri: queryStringOr(query, "redirect_uri", ""),
      code_challenge: queryStringOr(query, "code_challenge", ""),
      code_challenge_method: queryStringOr(query, "code_challenge_method", DEFAULT_CODE_CHALLENGE_METHOD),
      state: queryStringOr(query, "state", ""),
      response_type: queryStringOr(query, "response_type", "code"),
    };
  },
  parseBody(value: JsonValue): OAuthAuthorizationRequest {
    const obj = recordOf(value);
    return {
      client_id: stringFieldOr(obj, "client_id", ""),
      redirect_uri: stringFieldOr(obj, "redirect_uri", ""),
      code_challenge: stringFieldOr(obj, "code_challenge", ""),
      code_challenge_method: stringFieldOr(obj, "code_challenge_method", DEFAULT_CODE_CHALLENGE_METHOD),
      state: stringFieldOr(obj, "state", ""),
      response_type: stringFieldOr(obj, "response_type", "code"),
    };
  },
};

// ─── Token requests (RFC 6749 §4.1.3 / §6) ───────────────────────────

/** `grant_type=authorization_code` token request. */
export interface OAuthAuthorizationCodeTokenRequest {
  grant_type: "authorization_code";
  code: string;
  code_verifier: string;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
}

/** `grant_type=refresh_token` token request. */
export interface OAuthRefreshTokenRequest {
  grant_type: "refresh_token";
  refresh_token: string;
}

/** The supported token-request union, discriminated by `grant_type`. */
export type OAuthTokenRequest = OAuthAuthorizationCodeTokenRequest | OAuthRefreshTokenRequest;

/** A token request whose `grant_type` is not supported by this server. */
export interface OAuthUnsupportedGrant {
  supported: false;
  grant_type: string;
}

function parseAuthorizationCodeTokenRequest(obj: JsonObject): OAuthAuthorizationCodeTokenRequest {
  const request: OAuthAuthorizationCodeTokenRequest = {
    grant_type: "authorization_code",
    code: stringFieldOr(obj, "code", ""),
    code_verifier: stringFieldOr(obj, "code_verifier", ""),
    client_id: stringFieldOr(obj, "client_id", ""),
    redirect_uri: stringFieldOr(obj, "redirect_uri", ""),
  };
  const clientSecret = stringFieldOrUndefined(obj, "client_secret");
  if (clientSecret !== undefined) request.client_secret = clientSecret;
  return request;
}

function parseRefreshTokenRequest(obj: JsonObject): OAuthRefreshTokenRequest {
  return {
    grant_type: "refresh_token",
    refresh_token: stringFieldOr(obj, "refresh_token", ""),
  };
}

export const OAuthTokenRequest = {
  /**
   * Parse a `/oauth/token` body into a supported token request, or an
   * `OAuthUnsupportedGrant` carrying the raw `grant_type` for the
   * `unsupported_grant_type` response. Distinguish via `"supported" in result`.
   */
  parse(value: JsonValue): OAuthTokenRequest | OAuthUnsupportedGrant {
    const obj = recordOf(value);
    const grantType = stringFieldOr(obj, "grant_type", "");
    if (grantType === "authorization_code") {
      return parseAuthorizationCodeTokenRequest(obj);
    }
    if (grantType === "refresh_token") {
      return parseRefreshTokenRequest(obj);
    }
    return { supported: false, grant_type: grantType };
  },
};

// ─── Response shapes ─────────────────────────────────────────────────

/** Successful token-endpoint response (RFC 6749 §5.1). */
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
}

/** OAuth error response (RFC 6749 §5.2), used across all endpoints. */
export interface OAuthErrorResponse {
  error: string;
  error_description: string;
}

/** Authorization Server Metadata (RFC 8414). */
export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: OAuthResponseType[];
  grant_types_supported: OAuthGrantType[];
  code_challenge_methods_supported: OAuthCodeChallengeMethod[];
  token_endpoint_auth_methods_supported: OAuthTokenEndpointAuthMethod[];
}

/** Protected Resource Metadata (RFC 9728). */
export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
}
