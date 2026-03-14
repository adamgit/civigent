import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CoordinationPage } from "../../../pages/CoordinationPage";
import { jsonResponse } from "../../helpers/fetch-mocks";

let wsOnEventHandler: ((event: unknown) => void) | null = null;

vi.mock("../../../services/ws-client", () => ({
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

function renderCoordination() {
  return render(
    <MemoryRouter>
      <CoordinationPage />
    </MemoryRouter>,
  );
}

describe("CoordinationPage event log", () => {
  beforeEach(() => {
    wsOnEventHandler = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/heatmap")) {
        return jsonResponse({ preset: "eager", humanInvolvement_midpoint_seconds: 7200, humanInvolvement_steepness: 1, sections: [] });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows empty event log initially", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("No events yet.")).toBeDefined();
    });
  });

  it("content:committed event rendered in log", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("No events yet.")).toBeDefined();
    });

    act(() => {
      wsOnEventHandler!({
        type: "content:committed",
        doc_path: "ops/strategy.md",
        sections: [{ heading_path: ["Overview"] }],
        writer_id: "agent-1",
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/content:committed/)).toBeDefined();
      expect(screen.getByText(/ops\/strategy.md/)).toBeDefined();
    });
  });

  it("presence:editing event rendered in log", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("No events yet.")).toBeDefined();
    });

    act(() => {
      wsOnEventHandler!({
        type: "presence:editing",
        doc_path: "ops/strategy.md",
        heading_path: ["Overview"],
        writer_id: "human-1",
        writer_display_name: "Alice",
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/presence:editing/)).toBeDefined();
      expect(screen.getByText(/Alice editing ops\/strategy.md/)).toBeDefined();
    });
  });

  it("presence:done event rendered in log", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("No events yet.")).toBeDefined();
    });

    act(() => {
      wsOnEventHandler!({
        type: "presence:done",
        doc_path: "ops/strategy.md",
        writer_id: "human-1",
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/presence:done/)).toBeDefined();
      expect(screen.getByText(/human-1 stopped editing/)).toBeDefined();
    });
  });

  it("multiple events appear newest first", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("No events yet.")).toBeDefined();
    });

    act(() => {
      wsOnEventHandler!({
        type: "content:committed",
        doc_path: "first.md",
        sections: [],
        writer_id: "agent-1",
      });
    });

    act(() => {
      wsOnEventHandler!({
        type: "content:committed",
        doc_path: "second.md",
        sections: [],
        writer_id: "agent-2",
      });
    });

    await waitFor(() => {
      const items = screen.getAllByText(/content:committed/);
      expect(items.length).toBe(2);
    });

    // second.md should appear before first.md (newest first)
    const body = document.body.textContent ?? "";
    const secondIdx = body.indexOf("second.md");
    const firstIdx = body.indexOf("first.md");
    expect(secondIdx).toBeLessThan(firstIdx);
  });
});
