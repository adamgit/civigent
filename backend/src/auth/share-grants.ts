/**
 * Share-link grants — a capability to one document, or to a folder and
 * everything under it, signed with KS_SHARE_SALT.
 *
 * Same object family as the anonymous agent client_id: payload + HMAC signature,
 * stateless, salt-revocable. Possession of the token IS the credential.
 */

import { randomUUID } from "node:crypto";
import { mintHmacSignedToken, verifyHmacSignedToken } from "./oauth-tokens.js";
import { getShareSalt } from "./oauth-config.js";
import { DocPath, FolderPath, type ShareGrantExpiry, type ShareTarget } from "../types/shared.js";

const NEVER_EXPIRES_DAYS = 3650;

export type ShareGrantPayload = ShareTarget & {
  action: "read" | "write";
  token_use: "share_grant";
  exp: number;
  iat: number;
  jti: string;
  issued_by: string;
};

export function mintShareGrant(input: {
  target: ShareTarget;
  action: "read" | "write";
  expiry: ShareGrantExpiry;
  issuedBy: string;
}): { token: string; exp: number } {
  const days = input.expiry === "never" ? NEVER_EXPIRES_DAYS : input.expiry;
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + days * 24 * 60 * 60;
  const data: ShareGrantPayload = {
    ...input.target,
    action: input.action,
    token_use: "share_grant",
    exp,
    iat,
    jti: randomUUID(),
    issued_by: input.issuedBy,
  };
  return { token: mintHmacSignedToken(data as unknown as Record<string, unknown>, getShareSalt()), exp };
}

export function validateShareGrant(token: string): ShareGrantPayload | null {
  const data = verifyHmacSignedToken(token, getShareSalt());
  if (!data) return null;

  if (data.token_use !== "share_grant") return null;
  if (typeof data.path !== "string") return null;
  if (data.kind !== "file" && data.kind !== "folder") return null;
  if (data.kind === "file" && DocPath.tryParse(data.path) === null) return null;
  if (data.kind === "folder" && FolderPath.tryParse(data.path) === null) return null;
  if (data.action !== "read" && data.action !== "write") return null;
  if (typeof data.exp !== "number") return null;
  if (typeof data.iat !== "number") return null;
  if (typeof data.jti !== "string") return null;
  if (typeof data.issued_by !== "string") return null;

  const now = Math.floor(Date.now() / 1000);
  if (data.exp <= now) return null;

  return data as unknown as ShareGrantPayload;
}
