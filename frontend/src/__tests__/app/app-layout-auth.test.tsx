import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppLayout } from "../../app/AppLayout";
import { useCurrentUser } from "../../contexts/CurrentUserContext";
import { LoginPage } from "../../pages/LoginPage";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../helpers/fetch-mocks";

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn();
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

function renderLoginFlow(initialEntry: string) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <AppLayout />,
      children: [
        { path: "login", element: <LoginPage /> },
        { path: "target", element: <div data-testid="return-target">target</div> },
      ],
    },
  ], {
    initialEntries: [initialEntry],
  });

  return {
    router,
    ...render(<RouterProvider router={router} />),
  };
}

/** Helper: authenticated session response */
function sessionResponse(name: string) {
  return jsonResponse({
    authenticated: true,
    app_name: "http://localhost:3000",
    user: { id: name.toLowerCase().replace(/\s/g, "-"), type: "human", displayName: name },
  });
}

/** Helper: unauthenticated session response */
function unauthenticatedSessionResponse() {
  return jsonResponse({ authenticated: false, app_name: "http://localhost:3000" });
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
      if (url === "/api/workspace/tree") {
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
      if (url === "/api/workspace/tree") {
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
        if (url === "/api/workspace/tree") return jsonResponse({ tree: [] });
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
        if (url === "/api/workspace/tree") return jsonResponse({ tree: [] });
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
    it("revalidates session on 'login' broadcast without taking over login navigation", async () => {
      let sessionCallCount = 0;
      fetchMock = installFetchMock(async (input) => {
        const url = String(input);
        if (url === "/api/workspace/tree") return jsonResponse({ tree: [] });
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

      // Auth sync updates shared identity but leaves navigation to LoginPage.
      await waitFor(() => {
        expect(
          screen.getByRole("button", {
            name: "Signed in as Logged In User. Open identity details.",
          }),
        ).toBeDefined();
      });
      expect(screen.getByTestId("login-page")).toBeDefined();
    });

    it("clears currentUser immediately on 'logout' broadcast", async () => {
      fetchMock = installFetchMock(async (input) => {
        const url = String(input);
        if (url === "/api/workspace/tree") return jsonResponse({ tree: [] });
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
        if (url === "/api/workspace/tree") return jsonResponse({ tree: [] });
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

  it("preserves and honors an explicit returnTo despite a delayed layout 401", async () => {
    const returnTo = "/target?mode=review#section";
    let resolveTree!: (response: Response) => void;
    const delayedTree = new Promise<Response>((resolve) => {
      resolveTree = resolve;
    });

    fetchMock = installFetchMock(async (input, init) => {
      const url = String(input);
      if (url === "/api/workspace/tree") return delayedTree;
      if (url === "/api/auth/session") return unauthenticatedSessionResponse();
      if (url === "/api/auth/methods") {
        return jsonResponse({
          methods: [{ type: "single_user", displayName: "Single-user session" }],
        });
      }
      if (url === "/api/auth/token/refresh") {
        return jsonResponse(
          { authenticated: false },
          { status: 401, statusText: "Unauthorized" },
        );
      }
      if (url === "/api/auth/login" && init?.method === "POST") {
        return jsonResponse({
          token: "test-token",
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          identity: { id: "user-1", type: "human", displayName: "Test User" },
        });
      }
      return jsonResponse({});
    });

    const initialEntry = `/login?returnTo=${encodeURIComponent(returnTo)}`;
    const { router } = renderLoginFlow(initialEntry);

    await waitFor(() => {
      expect(
        fetchMock.calls.some((call) => String(call.input) === "/api/workspace/tree"),
      ).toBe(true);
      expect(screen.getByTestId("login-single-user")).toBeDefined();
    });

    await act(async () => {
      resolveTree(jsonResponse(
        { message: "Unauthorized" },
        { status: 401, statusText: "Unauthorized" },
      ));
      await delayedTree;
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
      expect(router.state.location.search).toBe(
        `?returnTo=${encodeURIComponent(returnTo)}`,
      );
    });

    fireEvent.click(screen.getByTestId("login-single-user"));

    await waitFor(() => {
      expect(screen.getByTestId("return-target")).toBeDefined();
      expect(router.state.location.pathname).toBe("/target");
      expect(router.state.location.search).toBe("?mode=review");
      expect(router.state.location.hash).toBe("#section");
    });
  });
});
