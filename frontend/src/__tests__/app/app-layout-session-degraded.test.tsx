/**
 * Regression: the authoritative session check must never fail silently.
 *
 * `revalidateSession` used to end in `.catch(() => {})`, so a 500 / network /
 * malformed response on the initial load left the user silently signed-out with
 * no log, diagnostic, or visible state (no-silent-error policy violation). These
 * tests pin the replacement:
 *   (a) a 500 on the INITIAL load surfaces a visible degraded banner and records
 *       a `session-revalidate` diagnostic.
 *   (b) a 500 on a BACKGROUND refresh records a diagnostic and falls back to
 *       signed-out without throwing or surfacing a hard banner.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppLayout } from "../../app/AppLayout";
import { useCurrentUser } from "../../contexts/CurrentUserContext";
import { recordWsDiag } from "../../services/ws-diagnostics";
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

// Keep the real ring buffer behavior but spy on the recorder so the tests can
// assert the dropped error was actually recorded rather than discarded.
vi.mock("../../services/ws-diagnostics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/ws-diagnostics")>();
  return { ...actual, recordWsDiag: vi.fn() };
});

function CurrentUserProbe() {
  const currentUser = useCurrentUser();
  return <div data-testid="current-user">{currentUser?.displayName ?? "signed-out"}</div>;
}

function renderAppLayout(initialEntries: string[] = ["/"]) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <AppLayout />,
      children: [{ index: true, element: <CurrentUserProbe /> }],
    },
  ], { initialEntries });
  return render(<RouterProvider router={router} />);
}

function sessionResponse(name: string) {
  return jsonResponse({
    authenticated: true,
    user: { id: name.toLowerCase().replace(/\s/g, "-"), type: "human", displayName: name },
  });
}

function serverError() {
  return jsonResponse({ error: "boom" }, { status: 500, statusText: "Internal Server Error" });
}

function sessionRevalidateDiagCount(): number {
  return (recordWsDiag as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([entry]) => entry?.source === "session-revalidate",
  ).length;
}

describe("AppLayout session degraded state", () => {
  let fetchMock: InstalledFetchMock;

  beforeEach(() => {
    localStorage.clear();
    (recordWsDiag as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    fetchMock?.restore();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("(a) a 500 on the initial session check surfaces a degraded banner and records a diag", async () => {
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url === "/api/workspace/tree") return jsonResponse({ tree: [] });
      if (url === "/api/auth/session") return serverError();
      return jsonResponse({});
    });

    renderAppLayout();

    await waitFor(() => {
      expect(screen.getByTestId("session-degraded")).toBeDefined();
    });
    // Soft fallback: identity is signed-out, not a stale or crashed state.
    expect(screen.getByTestId("current-user").textContent).toBe("signed-out");
    // The dropped error was recorded, not discarded.
    expect(sessionRevalidateDiagCount()).toBeGreaterThan(0);
  });

  it("(b) a 500 on a background refresh records a diag and falls back to signed-out without a banner", async () => {
    let failSession = false;
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url === "/api/workspace/tree") return jsonResponse({ tree: [] });
      if (url === "/api/auth/session") {
        return failSession ? serverError() : sessionResponse("Active User");
      }
      return jsonResponse({});
    });

    renderAppLayout();

    await waitFor(() => {
      expect(screen.getByTestId("current-user").textContent).toBe("Active User");
    });

    const diagsBefore = sessionRevalidateDiagCount();

    // Background refresh (window focus) now fails with a 500.
    failSession = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("current-user").textContent).toBe("signed-out");
    });
    // Background failure stays soft: it records a diag but shows no hard banner.
    expect(sessionRevalidateDiagCount()).toBeGreaterThan(diagsBefore);
    expect(screen.queryByTestId("session-degraded")).toBeNull();
  });
});
