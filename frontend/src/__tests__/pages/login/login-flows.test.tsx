import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "../../../pages/LoginPage";
import { jsonResponse } from "../../helpers/fetch-mocks";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    useNavigate: () => mockNavigate,
  };
});

let fetchMock: ReturnType<typeof vi.fn>;

function renderLogin(initialEntries: string[] = ["/login"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage flows", () => {
  beforeEach(() => {
    mockNavigate.mockClear();

    fetchMock = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);

      if (urlStr.includes("/api/auth/methods")) {
        return jsonResponse({ methods: ["single_user", "credentials"] });
      }

      if (urlStr.includes("/api/auth/login") && init?.method === "POST") {
        return jsonResponse({
          token: "test-token",
          identity: { id: "user-1", type: "human", displayName: "Test User" },
        });
      }

      if (urlStr.includes("/api/auth/logout") && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }

      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("single-user login calls loginSingleUser and redirects", async () => {
    renderLogin();
    await waitFor(() => {
      expect(screen.getByText("Use single-user session")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Use single-user session"));

    await waitFor(() => {
      const loginCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/api/auth/login") && call[1]?.method === "POST",
      );
      expect(loginCalls.length).toBeGreaterThan(0);
    });

    // Should navigate to default returnTo "/"
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/");
    });
  });

  it("credentials login calls loginCredentials with form values", async () => {
    renderLogin();
    await waitFor(() => {
      expect(screen.getByText("Sign in")).toBeDefined();
    });

    const emailInput = screen.getByLabelText("Email");
    const passwordInput = screen.getByLabelText("Password");

    fireEvent.change(emailInput, { target: { value: "user@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "secret123" } });
    fireEvent.click(screen.getByText("Sign in"));

    await waitFor(() => {
      const loginCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/api/auth/login") && call[1]?.method === "POST",
      );
      expect(loginCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(loginCalls[0][1]!.body as string);
      expect(body.email).toBe("user@example.com");
      expect(body.password).toBe("secret123");
    });
  });

  it("successful login shows confirmation message", async () => {
    renderLogin();
    await waitFor(() => {
      expect(screen.getByText("Use single-user session")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Use single-user session"));

    await waitFor(() => {
      expect(screen.getByText(/Authenticated as Test User/)).toBeDefined();
    });
  });

  it("successful login redirects to returnTo path", async () => {
    renderLogin(["/login?returnTo=/docs"]);
    await waitFor(() => {
      expect(screen.getByText("Use single-user session")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Use single-user session"));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/docs");
    });
  });

  it("failed login shows error message", async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/auth/methods")) {
        return jsonResponse({ methods: ["single_user"] });
      }
      if (urlStr.includes("/api/auth/login") && init?.method === "POST") {
        throw new Error("Invalid credentials");
      }
      return jsonResponse({});
    });

    renderLogin();
    await waitFor(() => {
      expect(screen.getByText("Use single-user session")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Use single-user session"));

    await waitFor(() => {
      expect(screen.getByText(/Auth error: Invalid credentials/)).toBeDefined();
    });
  });

  it("logout button calls logout and shows message", async () => {
    renderLogin();
    await waitFor(() => {
      expect(screen.getByText("Clear session")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Clear session"));

    await waitFor(() => {
      const logoutCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/api/auth/logout") && call[1]?.method === "POST",
      );
      expect(logoutCalls.length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(screen.getByText("Session cleared.")).toBeDefined();
    });
  });
});
