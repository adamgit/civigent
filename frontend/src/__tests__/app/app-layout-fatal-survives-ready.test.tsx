/**
 * Canary: a process fatal is not resolved by lifecycle `ready`.
 * Refresh / SSE ready / recovery poll must not dismiss SystemFatalScreen.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppLayout } from "../../app/AppLayout";
import { connectSystemEvents, type SystemState } from "../../services/system-events-client";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../helpers/fetch-mocks";

let wsOnEvent: ((event: { type: string; report?: unknown }) => void) | null = null;
const systemStateListeners: Array<(state: SystemState) => void> = [];

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn((handler: (event: { type: string; report?: unknown }) => void) => {
      wsOnEvent = handler;
    });
    focusDocument = vi.fn();
    blurDocument = vi.fn();
  },
}));

vi.mock("../../services/system-events-client", () => ({
  connectSystemEvents: vi.fn((cb: (state: SystemState) => void) => {
    systemStateListeners.push(cb);
    return () => {};
  }),
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

function renderAppLayout() {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <AppLayout />,
      children: [{ index: true, element: <div data-testid="outlet-alive">ok</div> }],
    },
  ], { initialEntries: ["/"] });
  return render(<RouterProvider router={router} />);
}

describe("AppLayout fatal survives lifecycle ready", () => {
  let fetchMock: InstalledFetchMock;

  beforeEach(() => {
    localStorage.clear();
    wsOnEvent = null;
    systemStateListeners.length = 0;
  });

  afterEach(() => {
    fetchMock?.restore();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps SystemFatalScreen after the lifecycle SSE reports ready", async () => {
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url === "/api/workspace/tree") return jsonResponse({ tree: [] });
      if (url === "/api/auth/session") {
        return jsonResponse({
          authenticated: true,
          user: { id: "alice", type: "human", displayName: "Alice" },
        });
      }
      return jsonResponse({});
    });

    renderAppLayout();

    await waitFor(() => {
      expect(wsOnEvent).not.toBeNull();
    });

    await act(async () => {
      wsOnEvent!({
        type: "system:fatal",
        report: {
          message: "publish exploded",
          stack: "Error: publish exploded",
          cause: null,
          origin: "unhandledRejection",
          timestamp: "2026-09-11T00:00:00.000Z",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("system-fatal-screen")).toBeDefined();
    });

    expect(connectSystemEvents).toHaveBeenCalled();
    expect(systemStateListeners.length).toBeGreaterThan(0);

    await act(async () => {
      for (const listener of systemStateListeners) {
        listener({ state: "ready" });
      }
    });

    expect(screen.getByTestId("system-fatal-screen")).toBeDefined();
    expect(screen.queryByTestId("outlet-alive")).toBeNull();
  });
});
