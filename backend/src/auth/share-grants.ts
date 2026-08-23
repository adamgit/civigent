/**
 * Share-link grants — a capability to one document, signed with KS_SHARE_SALT.
 *
 * Same object family as the anonymous agent client_id: payload + HMAC signature,
 * stateless, salt-revocable. Possession of the token IS the credential.
 */

import { randomUUID } from "node:crypto";
import { mintHmacSignedToken, verifyHmacSignedToken } from "./oauth-tokens.js";
import { getShareSalt } from "./oauth-config.js";
import { DocPath } from "../types/shared.js";

export interface ShareGrantPayload {
  doc_path: string;
  action: "read" | "write";
  token_use: "share_grant";
  exp: number;
  iat: number;
  jti: string;
  issued_by: string;
}

export function mintShareGrant(input: {
  docPath: DocPath;
  action: "read" | "write";
  expiresInDays: number;
  issuedBy: string;
}): { token: string; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + input.expiresInDays * 24 * 60 * 60;
  const data: ShareGrantPayload = {
    doc_path: input.docPath,
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
  if (typeof data.doc_path !== "string" || DocPath.tryParse(data.doc_path) === null) return null;
  if (data.action !== "read" && data.action !== "write") return null;
  if (typeof data.exp !== "number") return null;
  if (typeof data.iat !== "number") return null;
  if (typeof data.jti !== "string") return null;
  if (typeof data.issued_by !== "string") return null;

  const now = Math.floor(Date.now() / 1000);
  if (data.exp <= now) return null;

  return data as unknown as ShareGrantPayload;
}
