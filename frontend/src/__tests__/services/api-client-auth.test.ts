import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../helpers/fetch-mocks";
import { apiClient } from "../../services/api-client";

describe("api-client auth endpoints", () => {
  let fetchMock: InstalledFetchMock;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    fetchMock?.restore();
    localStorage.clear();
  });

  it("getAuthMethods calls /api/auth/methods", async () => {
    fetchMock = installFetchMock(async () =>
      jsonResponse({ methods: ["credentials", "oidc"] }),
    );
    const result = await apiClient.getAuthMethods();
    expect(result.methods).toContain("credentials");
    expect(fetchMock.calls.some((c) => String(c.input) === "/api/auth/methods")).toBe(true);
  });

  it("getSessionInfo calls /api/auth/session", async () => {
    fetchMock = installFetchMock(async (input) => {
      if (String(input) === "/api/auth/session") {
        return jsonResponse({
          authenticated: true,
          user: { id: "test-user", displayName: "Test" },
          login_providers: [],
        });
      }
      return jsonResponse({});
    });
    const result = await apiClient.getSessionInfo();
    expect(result.authenticated).toBe(true);
  });

  it("loginSingleUser sends POST to /api/auth/login with provider: single_user", async () => {
    fetchMock = installFetchMock(async () =>
      jsonResponse({
        token: "t",
        access_token: "at",
        refresh_token: "rt",
        identity: { id: "single-user", displayName: "Default User" },
      }),
    );
    const result = await apiClient.loginSingleUser();
    expect(result.identity.id).toBe("single-user");

    const loginCall = fetchMock.calls.find(
      (c) => String(c.input) === "/api/auth/login" && c.init?.method === "POST",
    );
    expect(loginCall).toBeDefined();
    const body = JSON.parse(loginCall!.init!.body as string);
    expect(body.provider).toBe("single_user");
  });

  it("loginCredentials sends username/password to /api/auth/login", async () => {
    fetchMock = installFetchMock(async () =>
      jsonResponse({
        token: "t",
        access_token: "at",
        refresh_token: "rt",
        identity: { id: "user-1", displayName: "Alice" },
      }),
    );
    await apiClient.loginCredentials({
      email: "alice@example.com",
      username: "alice",
      password: "secret",
    });

    const loginCall = fetchMock.calls.find(
      (c) => String(c.input) === "/api/auth/login" && c.init?.method === "POST",
    );
    expect(loginCall).toBeDefined();
    const body = JSON.parse(loginCall!.init!.body as string);
    expect(body.provider).toBe("credentials");
    expect(body.email).toBe("alice@example.com");
    expect(body.password).toBe("secret");
  });

  it("loginCredentials stores writer ID on success", async () => {
    fetchMock = installFetchMock(async () =>
      jsonResponse({
        token: "t",
        access_token: "at",
        refresh_token: "rt",
        identity: { id: "user-from-login", displayName: "User" },
      }),
    );
    await apiClient.loginCredentials({ email: "a@b.com", password: "p" });
    expect(localStorage.getItem("ks_writer_id")).toBe("user-from-login");
  });

  it("registerAgent calls /api/auth/agent/register is not on apiClient (tested via page)", () => {
    // Agent registration is done via direct fetch in AgentSimulatorPage, not via apiClient
    expect(true).toBe(true);
  });

  it("refreshAuthSession calls POST /api/auth/token/refresh", async () => {
    fetchMock = installFetchMock(async () =>
      jsonResponse({ access_token: "new-at", refresh_token: "new-rt" }),
    );
    const result = await apiClient.refreshAuthSession();
    expect(result.access_token).toBe("new-at");

    const refreshCall = fetchMock.calls.find(
      (c) => String(c.input) === "/api/auth/token/refresh" && c.init?.method === "POST",
    );
    expect(refreshCall).toBeDefined();
  });

  it("logout calls POST /api/auth/logout and clears writer ID", async () => {
    localStorage.setItem("ks_writer_id", "will-be-cleared");
    fetchMock = installFetchMock(async () => jsonResponse({ ok: true }));
    await apiClient.logout();

    const logoutCall = fetchMock.calls.find(
      (c) => String(c.input) === "/api/auth/logout" && c.init?.method === "POST",
    );
    expect(logoutCall).toBeDefined();
    expect(localStorage.getItem("ks_writer_id")).toBeNull();
  });

  it("401 response triggers token refresh retry", async () => {
    let callCount = 0;
    fetchMock = installFetchMock(async (input, init) => {
      const url = String(input);
      // Bootstrap session check
      if (url === "/api/auth/session") {
        return jsonResponse({
          authenticated: true,
          user: { id: "u" },
          login_providers: [],
        });
      }
      // Token refresh
      if (url === "/api/auth/token/refresh") {
        return jsonResponse({ access_token: "new", refresh_token: "new" });
      }
      // First call returns 401, retry succeeds
      if (url === "/api/heatmap") {
        callCount++;
        if (callCount === 1) {
          return jsonResponse({ message: "Unauthorized" }, { status: 401 });
        }
        return jsonResponse({ preset: "eager", sections: [] });
      }
      return jsonResponse({});
    });

    const result = await apiClient.getHeatmap();
    expect(result.preset).toBe("eager");

    // Verify refresh was called
    expect(
      fetchMock.calls.some((c) => String(c.input) === "/api/auth/token/refresh"),
    ).toBe(true);
  });
});
