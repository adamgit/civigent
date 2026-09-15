import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64UrlEncode } from "../../auth/encoding.js";
import { resolveWriterWithExpiry } from "../../auth/context.js";
import { getShareSalt } from "../../auth/oauth-config.js";

function signShareAccessToken(scopeClaims: Record<string, unknown>): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: "human-malformed-share",
      type: "human",
      display_name: "Malformed Share Guest",
      token_use: "access",
      iat: nowSeconds,
      exp: nowSeconds + 1800,
      jti: "malformed-share-session",
      auth_source: "share",
      scope_action: "read",
      grant_jti: "share-grant",
      grant_exp: nowSeconds + 3600,
      ...scopeClaims,
    }),
  );
  const signature = base64UrlEncode(
    createHmac("sha256", getShareSalt()).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

describe("share-session authentication context (spec 08)", () => {
  it("rejects signed share sessions with a missing or invalid discriminated scope", () => {
    const malformedTokens = [
      signShareAccessToken({ scope_path: "/shared" }),
      signShareAccessToken({ scope_kind: "folder", scope_path: 42 }),
    ];

    const resolved = malformedTokens.map((token) =>
      resolveWriterWithExpiry(
        { authorization: `Bearer ${token}` },
        { requireExplicitAuth: true },
      ),
    );

    expect(resolved).toEqual([null, null]);
  });
});
