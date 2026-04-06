import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { jsonResponse } from "../helpers/fetch-mocks";

let wsOnEventHandler: ((event: unknown) => void) | null = null;

vi.mock("../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect() {}
    disconnect() {}
    onEvent(handler: (event: unknown) => void) {
      wsOnEventHandler = handler;
    }
    subscribe() {}
    unsubscribe() {}
  },
}));

vi.mock("../../services/api-client", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    resolveWriterId: () => "test-user",
  };
});

import { MirrorPanel } from "../../components/MirrorPanel";

let fetchMock: ReturnType<typeof vi.fn>;

describe("MirrorPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wsOnEventHandler = null;

    fetchMock = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/mirror/dirty") || urlStr.includes("/api/writers/")) {
        return jsonResponse({
          writer_id: "test-user",
          documents: [],
        });
      }
      if (urlStr.includes("/api/publish") && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows 'Synced' pill when no dirty docs", async () => {
    render(<MirrorPanel />);
    await waitFor(() => {
      expect(screen.getByText("Synced")).toBeDefined();
    });
  });

  it("expands to show dirty doc list when dirty docs exist", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/mirror/dirty") || String(url).includes("/api/writers/")) {
        return jsonResponse({
          writer_id: "test-user",
          documents: [
            {
              doc_path: "ops/strategy.md",
              dirty_sections: [
                { heading_path: ["Overview"], base_head: "abc", change_magnitude: 5 },
              ],
            },
          ],
        });
      }
      return jsonResponse({});
    });

    render(<MirrorPanel />);
    await waitFor(() => {
      expect(screen.getByText("ops/strategy.md")).toBeDefined();
    });
    expect(screen.getByText("Unpublished Changes")).toBeDefined();
  });

  it("each dirty doc shows section heading paths", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/mirror/dirty") || String(url).includes("/api/writers/")) {
        return jsonResponse({
          writer_id: "test-user",
          documents: [
            {
              doc_path: "ops/strategy.md",
              dirty_sections: [
                { heading_path: ["Overview"], base_head: "abc", change_magnitude: 5 },
                { heading_path: ["Goals"], base_head: "def", change_magnitude: 3 },
              ],
            },
          ],
        });
      }
      return jsonResponse({});
    });

    render(<MirrorPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Overview/)).toBeDefined();
      expect(screen.getByText(/Goals/)).toBeDefined();
    });
  });

  it("'Publish Now' button calls publish for specific doc", async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/mirror/dirty") || urlStr.includes("/api/writers/")) {
        return jsonResponse({
          writer_id: "test-user",
          documents: [
            {
              doc_path: "ops/strategy.md",
              dirty_sections: [
                { heading_path: ["Overview"], base_head: "abc", change_magnitude: 5 },
              ],
            },
          ],
        });
      }
      if (urlStr.includes("/api/publish") && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });

    render(<MirrorPanel />);
    await waitFor(() => {
      expect(screen.getByText("Publish Now")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Publish Now"));

    await waitFor(() => {
      const publishCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/api/publish") && call[1]?.method === "POST",
      );
      expect(publishCalls.length).toBeGreaterThan(0);
    });
  });

  it("'Publish All' button calls publish", async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/mirror/dirty") || urlStr.includes("/api/writers/")) {
        return jsonResponse({
          writer_id: "test-user",
          documents: [
            {
              doc_path: "ops/strategy.md",
              dirty_sections: [
                { heading_path: ["Overview"], base_head: "abc", change_magnitude: 5 },
              ],
            },
          ],
        });
      }
      if (init?.method === "POST") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });

    render(<MirrorPanel />);
    await waitFor(() => {
      expect(screen.getByText("Publish All Docs")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Publish All Docs"));

    await waitFor(() => {
      const publishCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/api/publish") && call[1]?.method === "POST",
      );
      expect(publishCalls.length).toBeGreaterThan(0);
    });
  });

  it("dirty:changed WebSocket event adds dirty section", async () => {
    render(<MirrorPanel />);
    await waitFor(() => {
      expect(screen.getByText("Synced")).toBeDefined();
    });

    // Simulate dirty:changed event
    act(() => {
      wsOnEventHandler!({
        type: "dirty:changed",
        writer_id: "test-user",
        doc_path: "ops/strategy.md",
        heading_path: ["Overview"],
        dirty: true,
        base_head: "abc",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("ops/strategy.md")).toBeDefined();
    });
  });

  it("dirty:changed with dirty=false removes section", async () => {
    // Start with dirty state
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/mirror/dirty") || String(url).includes("/api/writers/")) {
        return jsonResponse({
          writer_id: "test-user",
          documents: [
            {
              doc_path: "ops/strategy.md",
              dirty_sections: [
                { heading_path: ["Overview"], base_head: "abc", change_magnitude: 5 },
              ],
            },
          ],
        });
      }
      return jsonResponse({});
    });

    render(<MirrorPanel />);
    await waitFor(() => {
      expect(screen.getByText("ops/strategy.md")).toBeDefined();
    });

    // Mark clean via WS
    act(() => {
      wsOnEventHandler!({
        type: "dirty:changed",
        writer_id: "test-user",
        doc_path: "ops/strategy.md",
        heading_path: ["Overview"],
        dirty: false,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Synced")).toBeDefined();
    });
  });

  it("polls every 5 seconds", async () => {
    render(<MirrorPanel />);

    // Wait for initial fetch
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    });

    const initialCalls = fetchMock.mock.calls.filter(
      (call: [unknown]) => {
        const urlStr = String(call[0]);
        return urlStr.includes("/api/mirror/dirty") || urlStr.includes("/api/writers/");
      },
    ).length;

    // Advance 5 seconds
    vi.advanceTimersByTime(5000);

    await waitFor(() => {
      const newCalls = fetchMock.mock.calls.filter(
        (call: [unknown]) => {
          const urlStr = String(call[0]);
          return urlStr.includes("/api/mirror/dirty") || urlStr.includes("/api/writers/");
        },
      ).length;
      expect(newCalls).toBeGreaterThan(initialCalls);
    });
  });
});
