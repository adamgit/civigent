import { afterEach, describe, expect, it, vi } from "vitest";

describe("KS_SHARE_SALT isolation", () => {
  const savedAuthSecret = process.env.KS_AUTH_SECRET;
  const savedShareSalt = process.env.KS_SHARE_SALT;

  afterEach(() => {
    if (savedAuthSecret === undefined) delete process.env.KS_AUTH_SECRET;
    else process.env.KS_AUTH_SECRET = savedAuthSecret;
    if (savedShareSalt === undefined) delete process.env.KS_SHARE_SALT;
    else process.env.KS_SHARE_SALT = savedShareSalt;
    vi.resetModules();
  });

  it("rotating KS_SHARE_SALT invalidates share sessions and leaves ordinary sessions valid", async () => {
    process.env.KS_AUTH_SECRET = "canary-auth-secret";
    process.env.KS_SHARE_SALT = "canary-share-salt-1";
    vi.resetModules();
    const tokensBefore = await import("../../auth/tokens.js");

    const ordinary = tokensBefore.issueTokenPair({
      id: "ordinary-human",
      type: "human",
      displayName: "Ordinary",
    });
    const scoped = tokensBefore.issueScopedTokenPair(
      { id: "human-share-salt", type: "human", displayName: "Share Guest" },
      {
        docPath: "/shared.md",
        action: "read",
        grantJti: "grant-jti-salt",
        grantExp: Math.floor(Date.now() / 1000) + 3600,
      },
    );

    process.env.KS_SHARE_SALT = "canary-share-salt-2";
    vi.resetModules();
    const tokensAfter = await import("../../auth/tokens.js");

    expect(() => tokensAfter.decodeAndValidateToken(ordinary.access_token)).not.toThrow();
    expect(() => tokensAfter.decodeAndValidateToken(scoped.access_token)).toThrow(
      tokensAfter.InvalidAuthTokenError,
    );
  });
});
