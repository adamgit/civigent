import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CoordinationPage } from "../../../pages/CoordinationPage";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { GetHeatmapResponse } from "../../../types/shared";

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

const sampleHeatmap: GetHeatmapResponse = {
  preset: "eager",
  humanInvolvement_midpoint_seconds: 7200,
  humanInvolvement_steepness: 1,
  sections: [
    {
      doc_path: "ops/strategy.md",
      heading_path: ["Overview"],
      humanInvolvement_score: 0.35,
      crdt_session_active: true,
      last_human_commit_sha: "abc123",
    },
    {
      doc_path: "ops/strategy.md",
      heading_path: ["Goals"],
      humanInvolvement_score: 0.75,
      crdt_session_active: false,
      last_human_commit_sha: null,
      block_reason: "involvement_threshold",
    },
    {
      doc_path: "marketing/plan.md",
      heading_path: ["Budget"],
      humanInvolvement_score: 0.1,
      crdt_session_active: false,
      last_human_commit_sha: null,
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

function renderCoordination() {
  return render(
    <MemoryRouter>
      <CoordinationPage />
    </MemoryRouter>,
  );
}

describe("CoordinationPage heatmap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsOnEventHandler = null;
    fetchMock = vi.fn().mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/heatmap")) {
        return jsonResponse(sampleHeatmap);
      }
      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fetches heatmap on mount", async () => {
    renderCoordination();
    await waitFor(() => {
      const heatmapCalls = fetchMock.mock.calls.filter(
        (call: [unknown]) => String(call[0]).includes("/api/heatmap"),
      );
      expect(heatmapCalls.length).toBeGreaterThan(0);
    });
  });

  it("renders table grouped by document", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("ops/strategy.md")).toBeDefined();
      expect(screen.getByText("marketing/plan.md")).toBeDefined();
    });
  });

  it("each row shows heading_path, human-involvement score, CRDT active status", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("Overview")).toBeDefined();
    });

    // Heading paths
    expect(screen.getByText("Goals")).toBeDefined();
    expect(screen.getByText("Budget")).toBeDefined();

    // Human-involvement scores (formatted to 2 decimal places)
    expect(screen.getByText("0.35")).toBeDefined();
    expect(screen.getByText("0.75")).toBeDefined();
    expect(screen.getByText("0.10")).toBeDefined();

    // CRDT active — "Yes" for active, "—" for inactive
    expect(screen.getByText("Yes")).toBeDefined();
  });

  it("blocked sections show block reason", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText(/involvement_threshold/)).toBeDefined();
    });
  });

  it("auto-refreshes every 10 seconds", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("Overview")).toBeDefined();
    });

    const initialCalls = fetchMock.mock.calls.filter(
      (call: [unknown]) => String(call[0]).includes("/api/heatmap"),
    ).length;

    // Advance 10 seconds
    vi.advanceTimersByTime(10000);

    await waitFor(() => {
      const newCalls = fetchMock.mock.calls.filter(
        (call: [unknown]) => String(call[0]).includes("/api/heatmap"),
      ).length;
      expect(newCalls).toBeGreaterThan(initialCalls);
    });
  });

  it("manual refresh button re-fetches heatmap", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeDefined();
    });

    const callsBefore = fetchMock.mock.calls.filter(
      (call: [unknown]) => String(call[0]).includes("/api/heatmap"),
    ).length;

    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => {
      const callsAfter = fetchMock.mock.calls.filter(
        (call: [unknown]) => String(call[0]).includes("/api/heatmap"),
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("shows empty state when no sections", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).includes("/api/heatmap")) {
        return jsonResponse({ preset: "eager", humanInvolvement_midpoint_seconds: 7200, humanInvolvement_steepness: 1, sections: [] });
      }
      return jsonResponse({});
    });

    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("No sections found.")).toBeDefined();
    });
  });

  it("shows current preset name", async () => {
    renderCoordination();
    await waitFor(() => {
      expect(screen.getByText("eager")).toBeDefined();
    });
  });
});
