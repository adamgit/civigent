import { readEnvVar } from "./env.js";
import { getPublicUrl } from "./auth/oauth-config.js";

/**
 * Human-facing name for this install (browser tab suffix, etc.).
 * `KS_APP_NAME` when set; otherwise {@link getPublicUrl}.
 */
export function getAppName(): string {
  const explicit = readEnvVar("KS_APP_NAME");
  if (explicit) return explicit;
  return getPublicUrl();
}
