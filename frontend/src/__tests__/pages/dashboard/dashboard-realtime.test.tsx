import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WsServerEvent } from "../../../types/shared";
import { jsonResponse } from "../../helpers/fetch-mocks";

// --- WsClient mock that captures the onEvent handler ---

type WsEventHandler = (event: WsServerEvent) => void;
let capturedWsHandler: WsEventHandler | null = null;

vi.mock("../../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = (handler: WsEventHandler) => {
      capturedWsHandler = handler;
    };
  },
}));

vi.mock("../../../services/api-client", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    resolveWriterId: () => "test-user",
  };
});

import { DashboardPage } from "../../../pages/DashboardPage";

let fetchCallCount: number;

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe("Dashboard realtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedWsHandler = null;
    fetchCallCount = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/activity")) {
        fetchCallCount += 1;
        return jsonResponse({
          items: [
            {
              id: `act-${fetchCallCount}`,
              timestamp: new Date().toISOString(),
              source: "agent_proposal",
              writer_id: "agent-1",
              writer_type: "agent",
              writer_display_name: "Agent Alpha",
              commit_sha: "abc123",
              sections: [{ doc_path: "ops/strategy.md", heading_path: ["Overview"] }],
              intent: "Latest update",
            },
          ],
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("content:committed WebSocket event triggers activity reload", async () => {
    await act(async () => {
      renderDashboard();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const initialFetchCount = fetchCallCount;

    // Emit content:committed event
    act(() => {
      capturedWsHandler?.({
        type: "content:committed",
        doc_path: "ops/strategy.md",
        source: "agent_proposal",
        writer_display_name: "Agent Alpha",
      } as WsServerEvent);
    });

    // Advance past debounce timer (180ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(fetchCallCount).toBeGreaterThan(initialFetchCount);
  });

  it("new activity from agents shows in list after reload", async () => {
    await act(async () => {
      renderDashboard();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await waitFor(() => {
      expect(screen.getByText(/Agent Alpha/)).toBeDefined();
    });

    // Emit content:committed to trigger reload
    act(() => {
      capturedWsHandler?.({
        type: "content:committed",
        doc_path: "ops/strategy.md",
        source: "agent_proposal",
        writer_display_name: "Agent Alpha",
      } as WsServerEvent);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // After reload, activity should still be visible
    await waitFor(() => {
      expect(screen.getByText(/Agent Alpha/)).toBeDefined();
    });
  });
});
