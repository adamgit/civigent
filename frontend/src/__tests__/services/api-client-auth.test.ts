import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installFetchMock, installQueuedFetchMock, jsonResponse, type InstalledFetchMock } from "../helpers/fetch-mocks";
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
      jsonResponse({ methods: ["oidc"] }),
    );
    const result = await apiClient.getAuthMethods();
    expect(result.methods).toContain("oidc");
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
    expect(localStorage.getItem("ks_writer_id")).toBe("single-user");
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

  describe("401 -> refresh -> retry", () => {
    it("retries the original request once after a successful browser refresh", async () => {
      // Sequence: bootstrap session -> 401 on /api/documents/tree -> refresh succeeds -> retry succeeds
      fetchMock = installQueuedFetchMock([
        // 1. tryBootstrapSingleUserSession calls /api/auth/session
        jsonResponse({ authenticated: true, user: { id: "u", displayName: "U" }, login_providers: [] }),
        // 2. Original request returns 401
        jsonResponse({ message: "Unauthorized" }, { status: 401, statusText: "Unauthorized" }),
        // 3. Refresh succeeds
        jsonResponse({ authenticated: true }),
        // 4. Retry of original request succeeds
        jsonResponse({ tree: [] }),
      ]);

      const result = await apiClient.getDocumentsTree();
      expect(result.tree).toEqual([]);

      // Verify the refresh was called
      const refreshCall = fetchMock.calls.find(
        (c) => String(c.input) === "/api/auth/token/refresh" && c.init?.method === "POST",
      );
      expect(refreshCall).toBeDefined();

      // Verify the original request was retried (called twice total)
      const treeCalls = fetchMock.calls.filter((c) => String(c.input) === "/api/documents/tree");
      expect(treeCalls.length).toBe(2);
    });

    it("does not retry when refresh fails", async () => {
      fetchMock = installQueuedFetchMock([
        // 1. tryBootstrapSingleUserSession calls /api/auth/session
        jsonResponse({ authenticated: true, user: { id: "u", displayName: "U" }, login_providers: [] }),
        // 2. Original request returns 401
        jsonResponse({ message: "Unauthorized" }, { status: 401, statusText: "Unauthorized" }),
        // 3. Refresh fails
        jsonResponse({ authenticated: false }, { status: 401, statusText: "Unauthorized" }),
      ]);

      await expect(apiClient.getDocumentsTree()).rejects.toThrow();

      // Should not have retried the original request
      const treeCalls = fetchMock.calls.filter((c) => String(c.input) === "/api/documents/tree");
      expect(treeCalls.length).toBe(1);
    });

    it("refresh hits POST /api/auth/token/refresh", async () => {
      fetchMock = installQueuedFetchMock([
        // 1. tryBootstrapSingleUserSession
        jsonResponse({ authenticated: true, user: { id: "u", displayName: "U" }, login_providers: [] }),
        // 2. 401 on original request
        jsonResponse({ message: "Unauthorized" }, { status: 401, statusText: "Unauthorized" }),
        // 3. Refresh
        jsonResponse({ authenticated: true }),
        // 4. Retry succeeds
        jsonResponse({ tree: [] }),
      ]);

      await apiClient.getDocumentsTree();

      const refreshCall = fetchMock.calls.find(
        (c) => String(c.input) === "/api/auth/token/refresh",
      );
      expect(refreshCall).toBeDefined();
      expect(refreshCall!.init?.method).toBe("POST");
    });
  });

  describe("refresh coalescing", () => {
    it("coalesces concurrent refresh callers into one network refresh", async () => {
      let refreshCallCount = 0;
      fetchMock = installFetchMock(async (input) => {
        if (String(input) === "/api/auth/token/refresh") {
          refreshCallCount++;
          // Small delay to ensure concurrent callers await the same promise
          await new Promise((r) => setTimeout(r, 10));
          return jsonResponse({ authenticated: true });
        }
        return jsonResponse({});
      });

      // Fire two concurrent refreshes
      const [a, b] = await Promise.all([
        apiClient.refreshAuthSession(),
        apiClient.refreshAuthSession(),
      ]);

      expect(a).toBe(true);
      expect(b).toBe(true);
      // Should have only made one network call
      expect(refreshCallCount).toBe(1);
    });
  });
});
