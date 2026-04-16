import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppLayout } from "../../app/AppLayout";
import { useCurrentUser } from "../../contexts/CurrentUserContext";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../helpers/fetch-mocks";

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn();
    sessionDeparture = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

vi.mock("../../services/system-events-client", () => ({
  connectSystemEvents: vi.fn(() => () => {}),
}));

vi.mock("../../components/DocumentsTreeNav", () => ({
  DocumentsTreeNav: () => <div data-testid="documents-tree-nav" />,
}));

vi.mock("../../components/SystemFatalScreen", () => ({
  SystemFatalScreen: () => <div data-testid="system-fatal-screen" />,
}));

vi.mock("../../services/recent-docs", () => ({
  rememberRecentDoc: vi.fn(),
}));

function CurrentUserProbe() {
  const currentUser = useCurrentUser();
  return <div data-testid="current-user">{currentUser?.displayName ?? "signed-out"}</div>;
}

function renderAppLayout(initialEntries: string[] = ["/"]) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <AppLayout />,
      children: [
        { index: true, element: <CurrentUserProbe /> },
        { path: "login", element: <div data-testid="login-page">login</div> },
      ],
    },
  ], {
    initialEntries,
  });

  return render(<RouterProvider router={router} />);
}

/** Helper: authenticated session response */
function sessionResponse(name: string) {
  return jsonResponse({
    authenticated: true,
    user: { id: name.toLowerCase().replace(/\s/g, "-"), type: "human", displayName: name },
  });
}

/** Helper: unauthenticated session response */
function unauthenticatedSessionResponse() {
  return jsonResponse({ authenticated: false });
}

describe("AppLayout auth state", () => {
  let fetchMock: InstalledFetchMock;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    fetchMock?.restore();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("loads the current user from session info on mount", async () => {
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url === "/api/documents/tree") {
        return jsonResponse({ tree: [] });
      }
      if (url === "/api/auth/session") {
        return sessionResponse("Cookie User");
      }
      return jsonResponse({});
    });

    renderAppLayout();

    await waitFor(() => {
      expect(screen.getByTestId("current-user").textContent).toBe("Cookie User");
    });
  });

  it("clears stale currentUser when session returns unauthenticated", async () => {
    let returnAuthenticated = true;
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url === "/api/documents/tree") {
        return jsonResponse({ tree: [] });
      }
      if (url === "/api/auth/session") {
        if (returnAuthenticated) return sessionResponse("Stale User");
        return unauthenticatedSessionResponse();
      }
      return jsonResponse({});
    });

    renderAppLayout();

    await waitFor(() => {
      expect(screen.getByTestId("current-user").textContent).toBe("Stale User");
    });

    // Switch to unauthenticated, then trigger revalidation via focus
    returnAuthenticated = false;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("current-user").textContent).toBe("signed-out");
    });
  });

  describe("visibilitychange revalidation", () => {
    it("revalidates session when tab becomes visible", async () => {
      let sessionCallCount = 0;
      fetchMock = installFetchMock(async (input) => {
        const url = String(input);
        if (url === "/api/documents/tree") return jsonResponse({ tree: [] });
        if (url === "/api/auth/session") {
          sessionCallCount++;
          return sessionResponse("Visible User");
        }
        return jsonResponse({});
      });

      renderAppLayout();

      await waitFor(() => {
        expect(screen.getByTestId("current-user").textContent).toBe("Visible User");
      });

      const countAfterMount = sessionCallCount;

      // Simulate becoming visible
      await act(async () => {
        Object.defineProperty(document, "visibilityState", { value: "visible", writable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await waitFor(() => {
        expect(sessionCallCount).toBeGreaterThan(countAfterMount);
      });
    });
  });

  describe("focus revalidation", () => {
    it("revalidates session on window focus", async () => {
      let sessionCallCount = 0;
      fetchMock = installFetchMock(async (input) => {
        const url = String(input);
        if (url === "/api/documents/tree") return jsonResponse({ tree: [] });
        if (url === "/api/auth/session") {
          sessionCallCount++;
          return sessionResponse("Focus User");
        }
        return jsonResponse({});
      });

      renderAppLayout();

      await waitFor(() => {
        expect(screen.getByTestId("current-user").textContent).toBe("Focus User");
      });

      const countAfterMount = sessionCallCount;

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() => {
        expect(sessionCallCount).toBeGreaterThan(countAfterMount);
      });
    });
  });

  describe("BroadcastChannel auth-sync", () => {
    it("revalidates session on 'login' broadcast and auto-exits /login page", async () => {
      let sessionCallCount = 0;
      fetchMock = installFetchMock(async (input) => {
        const url = String(input);
        if (url === "/api/documents/tree") return jsonResponse({ tree: [] });
        if (url === "/api/auth/session") {
          sessionCallCount++;
          if (sessionCallCount <= 1) return unauthenticatedSessionResponse();
          return sessionResponse("Logged In User");
        }
        return jsonResponse({});
      });

      renderAppLayout(["/login"]);

      // Initially on /login with unauthenticated state
      await waitFor(() => {
        expect(screen.getByTestId("login-page")).toBeDefined();
      });

      const countBefore = sessionCallCount;

      // Simulate a cross-tab login broadcast
      await act(async () => {
        const channel = new BroadcastChannel("ks_auth_sync");
        channel.postMessage("login");
        channel.close();
        // BroadcastChannel dispatch is async — give it a tick
        await new Promise((r) => setTimeout(r, 50));
      });

      await waitFor(() => {
        expect(sessionCallCount).toBeGreaterThan(countBefore);
      });

      // Should have navigated away from /login and loaded the user
      await waitFor(() => {
        expect(screen.getByTestId("current-user").textContent).toBe("Logged In User");
      });
    });

    it("clears currentUser immediately on 'logout' broadcast", async () => {
      fetchMock = installFetchMock(async (input) => {
        const url = String(input);
        if (url === "/api/documents/tree") return jsonResponse({ tree: [] });
        if (url === "/api/auth/session") return sessionResponse("Active User");
        return jsonResponse({});
      });

      renderAppLayout();

      await waitFor(() => {
        expect(screen.getByTestId("current-user").textContent).toBe("Active User");
      });

      // Simulate cross-tab logout
      await act(async () => {
        const channel = new BroadcastChannel("ks_auth_sync");
        channel.postMessage("logout");
        channel.close();
        await new Promise((r) => setTimeout(r, 50));
      });

      await waitFor(() => {
        expect(screen.getByTestId("current-user").textContent).toBe("signed-out");
      });
    });

    it("revalidates session on 'session_refreshed' broadcast", async () => {
      let sessionCallCount = 0;
      fetchMock = installFetchMock(async (input) => {
        const url = String(input);
        if (url === "/api/documents/tree") return jsonResponse({ tree: [] });
        if (url === "/api/auth/session") {
          sessionCallCount++;
          return sessionResponse("Refreshed User");
        }
        return jsonResponse({});
      });

      renderAppLayout();

      await waitFor(() => {
        expect(screen.getByTestId("current-user").textContent).toBe("Refreshed User");
      });

      const countBefore = sessionCallCount;

      await act(async () => {
        const channel = new BroadcastChannel("ks_auth_sync");
        channel.postMessage("session_refreshed");
        channel.close();
        await new Promise((r) => setTimeout(r, 50));
      });

      await waitFor(() => {
        expect(sessionCallCount).toBeGreaterThan(countBefore);
      });
    });
  });
});
