import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isBootstrapAvailable,
  redeemBootstrapCode,
  _resetBootstrapState,
  _setBootstrapCode,
} from "../../auth/service.js";

describe("Bootstrap code TTL and lifecycle", () => {
  beforeEach(() => {
    _resetBootstrapState();
  });

  afterEach(() => {
    _resetBootstrapState();
  });

  it("code works when available", async () => {
    _setBootstrapCode("test-code-123");
    expect(isBootstrapAvailable()).toBe(true);

    // redeemBootstrapCode calls grantAdmin which writes to disk — mock it
    const acl = await import("../../auth/acl.js");
    const spy = vi.spyOn(acl, "grantAdmin").mockResolvedValue();

    await redeemBootstrapCode("test-code-123", "user-1");
    expect(isBootstrapAvailable()).toBe(false);

    spy.mockRestore();
  });

  it("returns error after code is redeemed (no longer available)", async () => {
    _setBootstrapCode("test-code-456");

    const acl = await import("../../auth/acl.js");
    const spy = vi.spyOn(acl, "grantAdmin").mockResolvedValue();

    await redeemBootstrapCode("test-code-456", "user-1");

    await expect(redeemBootstrapCode("test-code-456", "user-2")).rejects.toThrowError(
      /not available/,
    );

    spy.mockRestore();
  });

  it("returns error when no code was generated", async () => {
    expect(isBootstrapAvailable()).toBe(false);
    await expect(redeemBootstrapCode("any-code", "user-1")).rejects.toThrowError(
      /not available/,
    );
  });

  it("redemption clears the code so subsequent attempts fail", async () => {
    _setBootstrapCode("redeem-test");

    const acl = await import("../../auth/acl.js");
    const spy = vi.spyOn(acl, "grantAdmin").mockResolvedValue();

    await redeemBootstrapCode("redeem-test", "user-1");
    expect(isBootstrapAvailable()).toBe(false);

    await expect(redeemBootstrapCode("redeem-test", "user-2")).rejects.toThrowError(/not available/);

    spy.mockRestore();
  });
});
