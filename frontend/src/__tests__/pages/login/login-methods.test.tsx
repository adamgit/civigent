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

  it("shows credentials form when credentials method available", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/auth/methods")) {
        return jsonResponse({ methods: ["credentials"] });
      }
      return jsonResponse({});
    });

    renderLogin();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Credentials/ })).toBeDefined();
    });
    expect(screen.getByText("Email")).toBeDefined();
    expect(screen.getByText("Password")).toBeDefined();
    expect(screen.getByText("Sign in")).toBeDefined();
  });

  it("shows OIDC form when oidc method available", async () => {
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

  it("only renders forms for available methods", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/auth/methods")) {
        return jsonResponse({ methods: ["credentials"] });
      }
      return jsonResponse({});
    });

    renderLogin();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Credentials/ })).toBeDefined();
    });

    // single_user button should NOT be present (not in methods list, and methods.length > 0)
    expect(screen.queryByText("Use single-user session")).toBeNull();
    // OIDC form should NOT be present
    expect(screen.queryByRole("heading", { name: /OIDC/ })).toBeNull();
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
