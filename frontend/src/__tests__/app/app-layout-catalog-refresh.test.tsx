/**
 * Frontend integration test — AppLayout must refresh its sidebar tree when
 * a `catalog:changed` WS event arrives, and the new doc must render.
 *
 * Diagnoses "MCP-created documents don't appear in sidebar tree" by isolating
 * the UI side from the backend emission path: the event is injected directly
 * into the mocked `KnowledgeStoreWsClient`'s `onEvent` handler, then we assert
 * both that `apiClient.getWorkspaceTree` is re-called (via the
 * `scheduleTreeRefresh` → `loadTree({background:true})` path in
 * AppLayout.tsx around lines 363–372) and that `DocumentsTreeNav` renders the
 * newly-added entry.
 *
 * The `KnowledgeStoreWsClient` stub here is faithful — it exposes a real
 * event-emit hook so the test drives the same code path production uses when
 * the WsHub forwards a server event.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppLayout } from "../../app/AppLayout";
import type { WsServerEvent, DocumentTreeEntry } from "../../types/shared";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../helpers/fetch-mocks";

type EventHandler = (event: WsServerEvent) => void;

const wsHandlers: EventHandler[] = [];
let eventToEmitOnConnect: WsServerEvent | null = null;

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn(() => {
      if (eventToEmitOnConnect) {
        for (const handler of wsHandlers) {
          handler(eventToEmitOnConnect);
        }
      }
    });
    disconnect = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
    focusSection = vi.fn();
    blurSection = vi.fn();
    openDocument = vi.fn();
    closeDocument = vi.fn();
    onEvent(handler: EventHandler): void {
      wsHandlers.push(handler);
    }
  },
}));

vi.mock("../../services/system-events-client", () => ({
  connectSystemEvents: vi.fn(() => () => {}),
}));

vi.mock("../../services/recent-docs", () => ({
  rememberRecentDoc: vi.fn(),
}));

function renderAppLayout() {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppLayout />,
        children: [{ index: true, element: <div data-testid="index-page" /> }],
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

function emitWsEvent(event: WsServerEvent): void {
  for (const handler of wsHandlers) {
    handler(event);
  }
}

describe("AppLayout tree refresh on catalog:changed", () => {
  let fetchMock: InstalledFetchMock;
  let treeFetchCount = 0;
  let currentTree: DocumentTreeEntry[] = [];

  beforeEach(() => {
    wsHandlers.length = 0;
    eventToEmitOnConnect = null;
    treeFetchCount = 0;
    currentTree = [];
    localStorage.clear();
    // Pre-expand /foo so DocumentsTreeNav renders its file children.
    localStorage.setItem("ks_sidebar_tree_expanded", JSON.stringify(["/foo"]));
  });

  afterEach(() => {
    fetchMock?.restore();
    eventToEmitOnConnect = null;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("calls getWorkspaceTree and renders the new doc after a catalog:changed event", async () => {
    currentTree = [];
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url === "/api/workspace/tree") {
        treeFetchCount += 1;
        return jsonResponse({ tree: currentTree });
      }
      if (url === "/api/auth/session") {
        return jsonResponse({
          authenticated: true,
          user: { id: "u1", type: "human", displayName: "Tester" },
        });
      }
      return jsonResponse({});
    });

    renderAppLayout();

    await waitFor(() => {
      expect(treeFetchCount).toBeGreaterThanOrEqual(1);
    });
    expect(wsHandlers.length).toBeGreaterThan(0);

    // Server-side state changes: the agent just created this doc.
    const newDocPath = "/foo/bar.md";
    currentTree = [
      {
        name: "foo",
        path: "/foo",
        type: "directory",
        children: [
          { name: "bar.md", path: newDocPath, type: "file" },
        ],
      },
    ];

    const fetchCountBefore = treeFetchCount;

    act(() => {
      emitWsEvent({
        type: "catalog:changed",
        added_doc_paths: [newDocPath],
        removed_doc_paths: [],
        writer_type: "agent",
        writer_display_name: "Agent Bot",
      } as WsServerEvent);
    });

    // scheduleTreeRefresh debounces by 180ms; real timers handle the wait.
    await waitFor(
      () => {
        expect(treeFetchCount).toBeGreaterThan(fetchCountBefore);
      },
      { timeout: 2000 },
    );

    await waitFor(() => {
      expect(screen.getByText("bar.md")).toBeDefined();
    });
  });

  it("does not drop a catalog:changed event emitted during WS connect", async () => {
    const newDocPath = "/foo/from-connect.md";
    fetchMock = installFetchMock(async (input) => {
      const url = String(input);
      if (url === "/api/workspace/tree") {
        treeFetchCount += 1;
        const tree = treeFetchCount === 1
          ? []
          : [
              {
                name: "foo",
                path: "/foo",
                type: "directory" as const,
                children: [
                  { name: "from-connect.md", path: newDocPath, type: "file" as const },
                ],
              },
            ];
        return jsonResponse({ tree });
      }
      if (url === "/api/auth/session") {
        return jsonResponse({
          authenticated: true,
          user: { id: "u1", type: "human", displayName: "Tester" },
        });
      }
      return jsonResponse({});
    });

    eventToEmitOnConnect = {
      type: "catalog:changed",
      added_doc_paths: [newDocPath],
      removed_doc_paths: [],
      writer_type: "agent",
      writer_display_name: "Agent Bot",
    } as WsServerEvent;

    renderAppLayout();

    await waitFor(
      () => {
        expect(treeFetchCount).toBeGreaterThan(1);
      },
      { timeout: 2000 },
    );
    await waitFor(() => {
      expect(screen.getByText("from-connect.md")).toBeDefined();
    });
  });
});
