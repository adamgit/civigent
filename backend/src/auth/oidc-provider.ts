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

import { discovery, buildAuthorizationUrl, authorizationCodeGrant } from "openid-client";
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

export async function redeemOidcCode(
  callbackUrl: URL,
  expectedState: string,
  expectedNonce: string,
): Promise<{ issuer: string; subject: string; email?: string; name?: string }> {
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

  return {
    issuer: claims.iss,
    subject: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined,
  };
}
