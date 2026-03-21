import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "../../../pages/LoginPage";
import { jsonResponse } from "../../helpers/fetch-mocks";

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage methods", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches auth methods on mount", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/auth/methods")) {
        return jsonResponse({ methods: ["single_user"] });
      }
      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    renderLogin();

    await waitFor(() => {
      const methodCalls = fetchMock.mock.calls.filter(
        (call: [unknown]) => String(call[0]).includes("/api/auth/methods"),
      );
      expect(methodCalls.length).toBeGreaterThan(0);
    });
  });

  it("shows single-user login button when single_user method available", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/auth/methods")) {
        return jsonResponse({ methods: ["single_user"] });
      }
      return jsonResponse({});
    });

    renderLogin();
    await waitFor(() => {
      expect(screen.getByText("Use single-user session")).toBeDefined();
    });
  });

  it("shows OIDC button when oidc method available", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/auth/methods")) {
        return jsonResponse({ methods: ["oidc"] });
      }
      return jsonResponse({});
    });

    renderLogin();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /OIDC/ })).toBeDefined();
    });
    expect(screen.getByText("Issuer")).toBeDefined();
    expect(screen.getByText("Subject")).toBeDefined();
    expect(screen.getByText("Sign in with OIDC")).toBeDefined();
  });

  it("only renders buttons for available methods", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/auth/methods")) {
        return jsonResponse({ methods: [{ type: "oidc", displayName: "SSO", authUrl: "/api/auth/oidc/authorize" }] });
      }
      return jsonResponse({});
    });

    renderLogin();
    await waitFor(() => {
      expect(screen.getByText("SSO")).toBeDefined();
    });
  });

  it("shows current writer ID", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/auth/methods")) {
        return jsonResponse({ methods: [] });
      }
      return jsonResponse({});
    });

    renderLogin();
    await waitFor(() => {
      expect(screen.getByText(/Current local identity:/)).toBeDefined();
    });
  });
});
