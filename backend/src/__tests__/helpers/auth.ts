import { issueTokenPair } from "../../auth/tokens.js";

export function authFor(id: string, type: "human" | "agent" = "human"): string {
  const token = issueTokenPair({
    id,
    type,
    displayName: id,
  }).access_token;
  return `Bearer ${token}`;
}
