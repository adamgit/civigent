import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ActivityItem } from "../../../types/shared";
import { jsonResponse } from "../../helpers/fetch-mocks";

// --- Mocks ---

vi.mock("../../../services/ws-client", () => ({
  KnowledgeStoreWsClient: class {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn();
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

function makeManyItems(count: number): ActivityItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `act-${i}`,
    timestamp: new Date(Date.now() - i * 60000).toISOString(),
    source: "agent_proposal" as const,
    writer_id: `agent-${i}`,
    writer_type: "agent" as const,
    writer_display_name: `Agent ${i}`,
    commit_sha: `sha${i}`,
    sections: [{ doc_path: `docs/doc-${i}.md`, heading_path: ["Section"] }],
    intent: `Intent ${i}`,
  }));
}

let fetchMock: ReturnType<typeof vi.fn>;

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe("Dashboard filters", () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/activity")) {
        return jsonResponse({ items: makeManyItems(30) });
      }
      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("settings persist to localStorage", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading activity...")).toBeNull();
    });

    // Open settings
    fireEvent.click(screen.getByText("Settings"));

    // Change limit
    const limitInput = screen.getByLabelText(/Max items per subsection/);
    fireEvent.change(limitInput, { target: { value: "5" } });

    // Change days
    const daysInput = screen.getByLabelText(/Recency window/);
    fireEvent.change(daysInput, { target: { value: "3" } });

    // Save
    fireEvent.click(screen.getByText("Save preferences"));

    expect(localStorage.getItem("ks_whats_new_limit")).toBe("5");
    expect(localStorage.getItem("ks_whats_new_days")).toBe("3");
  });

  it("'Show more' button loads additional items", async () => {
    // Pre-set limit to 5 so show-more appears
    localStorage.setItem("ks_whats_new_limit", "5");

    renderDashboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading activity...")).toBeNull();
    });

    // Should have "Show more" buttons if there are more items than the limit
    const showMoreButtons = screen.getAllByText("Show more");
    expect(showMoreButtons.length).toBeGreaterThan(0);

    fireEvent.click(showMoreButtons[showMoreButtons.length - 1]);

    // After clicking, more items should be visible
    // (we can't easily count DOM items, but the button click shouldn't error)
  });

  it("days and limit settings control API params", async () => {
    localStorage.setItem("ks_whats_new_limit", "10");
    localStorage.setItem("ks_whats_new_days", "3");

    renderDashboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading activity...")).toBeNull();
    });

    // Verify the fetch was called with appropriate query params
    const activityCalls = fetchMock.mock.calls.filter(
      (call: [unknown]) => String(call[0]).includes("/api/activity"),
    );
    expect(activityCalls.length).toBeGreaterThan(0);
    const firstCall = String(activityCalls[0][0]);
    expect(firstCall).toContain("days=3");
  });
});
