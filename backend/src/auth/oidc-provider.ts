/**
 * OIDC provider wrapper — lazily discovers and caches OIDC configuration.
 *
 * Uses openid-client v6. No Passport.
 *
 * Env vars:
 *   KS_OIDC_ISSUER       — OIDC issuer URL (required for oidc/hybrid mode)
 *   KS_OIDC_CLIENT_ID    — client ID (required for oidc/hybrid mode)
 *   KS_OIDC_CLIENT_SECRET — client secret (optional, for confidential clients)
 */

import { discovery, buildAuthorizationUrl, authorizationCodeGrant, fetchUserInfo } from "openid-client";
import { getOidcPublicUrl } from "./oauth-config.js";
import { readEnvVar } from "../env.js";

let _cachedConfig: Awaited<ReturnType<typeof discovery>> | null = null;

async function getOidcConfig(): Promise<Awaited<ReturnType<typeof discovery>>> {
  if (_cachedConfig) return _cachedConfig;

  const issuer = readEnvVar("KS_OIDC_ISSUER");
  const clientId = readEnvVar("KS_OIDC_CLIENT_ID");
  const clientSecret = readEnvVar("KS_OIDC_CLIENT_SECRET");

  if (!issuer || !clientId) {
    throw new Error("KS_OIDC_ISSUER and KS_OIDC_CLIENT_ID are required for OIDC.");
  }

  _cachedConfig = await discovery(
    new URL(issuer),
    clientId,
    clientSecret || undefined,
  );
  return _cachedConfig;
}

export function getRedirectUri(): string {
  return getOidcPublicUrl() + "/api/auth/oidc/callback";
}

export async function buildOidcRedirectUrl(state: string, nonce: string): Promise<string> {
  const config = await getOidcConfig();
  const redirectUrl = buildAuthorizationUrl(config, {
    redirect_uri: getRedirectUri(),
    scope: "openid email profile",
    state,
    nonce,
  });
  return redirectUrl.href;
}

export interface OidcRedeemedClaims {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  preferredUsername?: string;
}

function optionalStringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasUsableNameClaim(claims: {
  name?: string;
  givenName?: string;
  familyName?: string;
  preferredUsername?: string;
}): boolean {
  return Boolean(
    claims.name ||
    claims.givenName ||
    claims.familyName ||
    claims.preferredUsername,
  );
}

function pickNameFields(source: Record<string, unknown>): {
  name?: string;
  givenName?: string;
  familyName?: string;
  preferredUsername?: string;
  email?: string;
} {
  return {
    name: optionalStringClaim(source.name),
    givenName: optionalStringClaim(source.given_name),
    familyName: optionalStringClaim(source.family_name),
    preferredUsername: optionalStringClaim(source.preferred_username),
    email: optionalStringClaim(source.email),
  };
}

export async function redeemOidcCode(
  callbackUrl: URL,
  expectedState: string,
  expectedNonce: string,
): Promise<OidcRedeemedClaims> {
  const config = await getOidcConfig();
  const tokens = await authorizationCodeGrant(
    config,
    callbackUrl,
    { expectedState, expectedNonce },
    { redirect_uri: getRedirectUri() },
  );

  const claims = tokens.claims();
  if (!claims) {
    throw new Error("OIDC token response contained no ID token claims.");
  }

  let nameFields = pickNameFields(claims as Record<string, unknown>);

  if (!hasUsableNameClaim(nameFields) && tokens.access_token) {
    try {
      const userInfo = await fetchUserInfo(config, tokens.access_token, claims.sub);
      const fromUserInfo = pickNameFields(userInfo as Record<string, unknown>);
      nameFields = {
        name: nameFields.name ?? fromUserInfo.name,
        givenName: nameFields.givenName ?? fromUserInfo.givenName,
        familyName: nameFields.familyName ?? fromUserInfo.familyName,
        preferredUsername: nameFields.preferredUsername ?? fromUserInfo.preferredUsername,
        email: nameFields.email ?? fromUserInfo.email,
      };
    } catch {
      // UserInfo is best-effort — login must still succeed on ID-token claims alone.
    }
  }

  return {
    issuer: claims.iss,
    subject: claims.sub,
    ...(nameFields.email ? { email: nameFields.email } : {}),
    ...(nameFields.name ? { name: nameFields.name } : {}),
    ...(nameFields.givenName ? { givenName: nameFields.givenName } : {}),
    ...(nameFields.familyName ? { familyName: nameFields.familyName } : {}),
    ...(nameFields.preferredUsername ? { preferredUsername: nameFields.preferredUsername } : {}),
  };
}
