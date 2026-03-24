import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../helpers/fetch-mocks";
import { apiClient, resolveWriterId, setWriterId, clearWriterId } from "../../services/api-client";

describe("api-client", () => {
  let fetchMock: InstalledFetchMock;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    fetchMock?.restore();
    localStorage.clear();
  });

  // ─── resolveWriterId ──────────────────────────────────────

  it('resolveWriterId returns "human-ui" by default', () => {
    expect(resolveWriterId()).toBe("human-ui");
  });

  it("resolveWriterId reads from localStorage if set", () => {
    localStorage.setItem("ks_writer_id", "custom-writer");
    expect(resolveWriterId()).toBe("custom-writer");
  });

  it("setWriterId stores to localStorage", () => {
    setWriterId("new-writer");
    expect(localStorage.getItem("ks_writer_id")).toBe("new-writer");
  });

  it("clearWriterId removes from localStorage", () => {
    setWriterId("temp-writer");
    clearWriterId();
    expect(localStorage.getItem("ks_writer_id")).toBeNull();
  });

  // ─── API method endpoints ─────────────────────────────────

  it("getHealth calls /api/health", async () => {
    fetchMock = installFetchMock(async () => jsonResponse({ ok: true }));
    await apiClient.getHealth();
    expect(fetchMock.calls.some((c) => String(c.input) === "/api/health")).toBe(true);
  });

  it("getDocumentsTree calls /api/documents/tree", async () => {
    fetchMock = installFetchMock(async (input) => {
      if (String(input).includes("/api/auth/session")) {
        return jsonResponse({ authenticated: true, user: { id: "u" }, login_providers: [] });
      }
      return jsonResponse({ tree: [] });
    });
    await apiClient.getDocumentsTree();
    expect(fetchMock.calls.some((c) => String(c.input).includes("/api/documents/tree"))).toBe(true);
  });

  it("getDocumentSections calls /api/documents/{encoded}/sections", async () => {
    fetchMock = installFetchMock(async (input) => {
      if (String(input).includes("/api/auth/session")) {
        return jsonResponse({ authenticated: true, user: { id: "u" }, login_providers: [] });
      }
      return jsonResponse({ sections: [] });
    });
    await apiClient.getDocumentSections("ops/strategy.md");
    expect(
      fetchMock.calls.some((c) =>
        String(c.input).includes(`/api/documents/${encodeURIComponent("ops/strategy.md")}/sections`),
      ),
    ).toBe(true);
  });

  it("listProposals calls /api/proposals", async () => {
    fetchMock = installFetchMock(async (input) => {
      if (String(input).includes("/api/auth/session")) {
        return jsonResponse({ authenticated: true, user: { id: "u" }, login_providers: [] });
      }
      return jsonResponse({ proposals: [] });
    });
    await apiClient.listProposals();
    expect(fetchMock.calls.some((c) => String(c.input) === "/api/proposals")).toBe(true);
  });

  it("listProposals with status filter appends query param", async () => {
    fetchMock = installFetchMock(async (input) => {
      if (String(input).includes("/api/auth/session")) {
        return jsonResponse({ authenticated: true, user: { id: "u" }, login_providers: [] });
      }
      return jsonResponse({ proposals: [] });
    });
    await apiClient.listProposals("pending");
    expect(fetchMock.calls.some((c) => String(c.input).includes("status=draft"))).toBe(true);
  });

  it("commitProposal calls POST /api/proposals/{id}/commit", async () => {
    fetchMock = installFetchMock(async (input) => {
      if (String(input).includes("/api/auth/session")) {
        return jsonResponse({ authenticated: true, user: { id: "u" }, login_providers: [] });
      }
      return jsonResponse({ status: "committed" });
    });
    await apiClient.commitProposal("prop-1");
    const commitCall = fetchMock.calls.find(
      (c) => String(c.input).includes("/api/proposals/prop-1/commit") && c.init?.method === "POST",
    );
    expect(commitCall).toBeDefined();
  });

  it("getActivity calls /api/activity with limit and days params", async () => {
    fetchMock = installFetchMock(async (input) => {
      if (String(input).includes("/api/auth/session")) {
        return jsonResponse({ authenticated: true, user: { id: "u" }, login_providers: [] });
      }
      return jsonResponse({ items: [] });
    });
    await apiClient.getActivity(50, 14);
    expect(fetchMock.calls.some((c) => String(c.input).includes("limit=50") && String(c.input).includes("days=14"))).toBe(true);
  });

  it("getHeatmap calls /api/heatmap", async () => {
    fetchMock = installFetchMock(async (input) => {
      if (String(input).includes("/api/auth/session")) {
        return jsonResponse({ authenticated: true, user: { id: "u" }, login_providers: [] });
      }
      return jsonResponse({ preset: "eager", sections: [] });
    });
    await apiClient.getHeatmap();
    expect(fetchMock.calls.some((c) => String(c.input) === "/api/heatmap")).toBe(true);
  });

  it("publish calls POST /api/publish", async () => {
    fetchMock = installFetchMock(async (input) => {
      if (String(input).includes("/api/auth/session")) {
        return jsonResponse({ authenticated: true, user: { id: "u" }, login_providers: [] });
      }
      return jsonResponse({ ok: true });
    });
    await apiClient.publish({ doc_path: "ops/strategy.md" });
    const publishCall = fetchMock.calls.find(
      (c) => String(c.input) === "/api/publish" && c.init?.method === "POST",
    );
    expect(publishCall).toBeDefined();
  });

  // ─── credentials: "include" ───────────────────────────────

  it('sets credentials: "include" on all fetch calls', async () => {
    fetchMock = installFetchMock(async () => jsonResponse({ ok: true }));
    await apiClient.getHealth();
    for (const call of fetchMock.calls) {
      expect(call.init?.credentials).toBe("include");
    }
  });

  // ─── Error handling ───────────────────────────────────────

  it("non-ok response throws with message from JSON body", async () => {
    fetchMock = installFetchMock(async () =>
      jsonResponse({ message: "Not found" }, { status: 404 }),
    );
    await expect(apiClient.getHealth()).rejects.toThrow("Not found");
  });

  it("non-ok response throws with raw text when not JSON", async () => {
    fetchMock = installFetchMock(async () =>
      new Response("Server Error", { status: 500 }),
    );
    await expect(apiClient.getHealth()).rejects.toThrow("Server Error");
  });
});
