import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateOAuthConfig } from "../../auth/oauth-config.js";

describe("validateOAuthConfig — single_user hostname guard", () => {
  const saved: Record<string, string | undefined> = {};

  function saveAndSet(vars: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("throws FATAL when single_user mode with a public hostname", () => {
    saveAndSet({
      KS_AUTH_MODE: "single_user",
      KS_EXTERNAL_HOSTNAME: "wiki.company.com",
      KS_EXTERNAL_PORT: "443",
    });

    expect(() => validateOAuthConfig()).toThrowError(/FATAL.*single_user.*mutually exclusive/);
  });

  it("allows single_user mode with localhost", () => {
    saveAndSet({
      KS_AUTH_MODE: "single_user",
      KS_EXTERNAL_HOSTNAME: "localhost",
      KS_EXTERNAL_PORT: "3000",
    });

    expect(() => validateOAuthConfig()).not.toThrow();
  });

  it("allows single_user mode with 127.0.0.1", () => {
    saveAndSet({
      KS_AUTH_MODE: "single_user",
      KS_EXTERNAL_HOSTNAME: "127.0.0.1",
      KS_EXTERNAL_PORT: "3000",
    });

    expect(() => validateOAuthConfig()).not.toThrow();
  });

  it("allows single_user mode when KS_EXTERNAL_HOSTNAME is unset (defaults to localhost)", () => {
    saveAndSet({
      KS_AUTH_MODE: "single_user",
      KS_EXTERNAL_HOSTNAME: undefined,
      KS_EXTERNAL_PORT: "3000",
    });

    expect(() => validateOAuthConfig()).not.toThrow();
  });
});
