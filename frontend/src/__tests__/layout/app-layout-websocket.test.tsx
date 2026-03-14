import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { sampleDocTree } from "../helpers/sample-data";
import type { WsServerEvent } from "../../types/shared";

// --- WsClient mock that captures the onEvent handler ---

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;
const mockWsConnect = vi.fn();
const mockWsDisconnect = vi.fn();

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = mockWsConnect;
    disconnect = mockWsDisconnect;
    onEvent = (handler: WsEventHandler) => {
      capturedWsHandler = handler;
    };
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    focusDocument = vi.fn();
    blurDocument = vi.fn();
    focusSection = vi.fn();
    blurSection = vi.fn();
    sessionDeparture = vi.fn();
  },
  __resetSessionWsManagerForTests: vi.fn(),
}));

vi.mock("../../components/DocumentsTreeNav", () => ({
  DocumentsTreeNav: (props: { entries: unknown[] }) => (
    <div data-testid="documents-tree-nav">
      Tree ({Array.isArray(props.entries) ? props.entries.length : 0} entries)
    </div>
  ),
}));

vi.mock("../../components/MirrorPanel", () => ({
  MirrorPanel: () => <div data-testid="mirror-panel">MirrorPanel</div>,
}));

vi.mock("../../services/recent-docs", () => ({
  rememberRecentDoc: vi.fn(),
}));

import { AppLayout } from "../../app/AppLayout";

let fetchMock: ReturnType<typeof vi.fn>;
let treeCallCount: number;

function renderLayout(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/*" element={<AppLayout />}>
          <Route index element={<div>Home</div>} />
          <Route path="docs/*" element={<div>Docs</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppLayout WebSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedWsHandler = null;
    treeCallCount = 0;
    fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/documents/tree")) {
        treeCallCount += 1;
        return new Response(JSON.stringify({ tree: sampleDocTree }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (typeof url === "string" && url.includes("/api/auth/session")) {
        return new Response(
          JSON.stringify({ authenticated: true, user: { id: "test-user" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("connects WebSocket on mount", async () => {
    await act(async () => {
      renderLayout();
    });
    expect(mockWsConnect).toHaveBeenCalled();
  });

  it("content:committed event refreshes document tree (debounced 180ms)", async () => {
    await act(async () => {
      renderLayout();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const initialTreeCalls = treeCallCount;

    // Emit content:committed event
    act(() => {
      capturedWsHandler?.({
        type: "content:committed",
        doc_path: "ops/strategy.md",
        source: "human_publish",
        writer_display_name: "User",
      } as WsServerEvent);
    });

    // Should not have refreshed yet (debounce)
    expect(treeCallCount).toBe(initialTreeCalls);

    // Advance past debounce timer
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(treeCallCount).toBeGreaterThan(initialTreeCalls);
  });

  it("content:committed from agent shows toast notification", async () => {
    await act(async () => {
      renderLayout();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      capturedWsHandler?.({
        type: "content:committed",
        doc_path: "ops/strategy.md",
        source: "agent_proposal",
        writer_display_name: "Agent Alpha",
      } as WsServerEvent);
    });

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeDefined();
      expect(screen.getByText(/Agent Alpha updated/)).toBeDefined();
    });
  });

  it("agent toast includes writer name and document path", async () => {
    await act(async () => {
      renderLayout();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      capturedWsHandler?.({
        type: "content:committed",
        doc_path: "eng/architecture.md",
        source: "agent_proposal",
        writer_display_name: "Bot Writer",
      } as WsServerEvent);
    });

    await waitFor(() => {
      const toast = screen.getByRole("status");
      expect(toast.textContent).toContain("Bot Writer");
      expect(toast.textContent).toContain("/eng/architecture.md");
    });
  });

  it("beforeunload warning fires when dirty sections exist", async () => {
    await act(async () => {
      renderLayout();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Simulate dirty:changed event
    act(() => {
      capturedWsHandler?.({
        type: "dirty:changed",
        doc_path: "ops/strategy.md",
        heading_path: ["Overview"],
        dirty: true,
      } as WsServerEvent);
    });

    const event = new Event("beforeunload", { cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("beforeunload warning does not fire when no dirty sections", async () => {
    await act(async () => {
      renderLayout();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const event = new Event("beforeunload", { cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });

  it("dirty:changed event updates dirty section tracking", async () => {
    await act(async () => {
      renderLayout();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Mark dirty
    act(() => {
      capturedWsHandler?.({
        type: "dirty:changed",
        doc_path: "ops/strategy.md",
        heading_path: ["Overview"],
        dirty: true,
      } as WsServerEvent);
    });

    // Verify dirty
    let event = new Event("beforeunload", { cancelable: true });
    let spy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(spy).toHaveBeenCalled();

    // Mark clean
    act(() => {
      capturedWsHandler?.({
        type: "dirty:changed",
        doc_path: "ops/strategy.md",
        heading_path: ["Overview"],
        dirty: false,
      } as WsServerEvent);
    });

    // Verify clean
    event = new Event("beforeunload", { cancelable: true });
    spy = vi.spyOn(event, "preventDefault");
    window.dispatchEvent(event);
    expect(spy).not.toHaveBeenCalled();
  });
});
