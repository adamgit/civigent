import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

const sampleItems: ActivityItem[] = [
  {
    id: "act-1",
    timestamp: "2026-01-15T10:00:00.000Z",
    writer_id: "agent-1",
    writer_type: "agent",
    writer_display_name: "Agent Alpha",
    commit_sha: "abc123",
    sections: [{ doc_path: "ops/strategy.md", heading_path: ["Overview"] }],
    intent: "Improve overview clarity",
  },
  {
    id: "act-2",
    timestamp: "2026-01-14T09:00:00.000Z",
    writer_id: "test-user",
    writer_type: "human",
    writer_display_name: "Test User",
    commit_sha: "def456",
    sections: [{ doc_path: "ops/strategy.md", heading_path: ["Goals"] }],
    intent: "Update goals",
  },
  {
    id: "act-3",
    timestamp: "2026-01-16T11:00:00.000Z",
    writer_id: "agent-2",
    writer_type: "agent",
    writer_display_name: "Agent Beta",
    commit_sha: "ghi789",
    sections: [{ doc_path: "eng/architecture.md", heading_path: ["Design"] }],
    intent: "Add design notes",
  },
];

function renderDashboard() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe("Dashboard activity", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/activity")) {
        return jsonResponse({ items: sampleItems });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("fetches activity on mount", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading activity...")).toBeNull();
    });
    expect(screen.getByText(/Agent Alpha/)).toBeDefined();
  });

  it("renders activity items with writer name, document path", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading activity...")).toBeNull();
    });
    expect(screen.getByText(/Agent Beta/)).toBeDefined();
    expect(screen.getByText("eng/architecture.md")).toBeDefined();
  });

  it("groups activity into 'Edits to your docs' and 'All other activity'", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading activity...")).toBeNull();
    });
    expect(screen.getByText(/Edits to your docs/)).toBeDefined();
    expect(screen.getByText(/All other activity/)).toBeDefined();
  });

  it("activity items link to source document", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading activity...")).toBeNull();
    });
    const docLinks = screen.getAllByText("eng/architecture.md");
    expect(docLinks.length).toBeGreaterThan(0);
    const link = docLinks[0].closest("a");
    expect(link?.getAttribute("href")).toContain("/docs/");
  });

  it("activity items link to source proposal when available", async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading activity...")).toBeNull();
    });
    const proposalLinks = screen.getAllByText("Proposal");
    expect(proposalLinks.length).toBeGreaterThan(0);
    const link = proposalLinks[0].closest("a");
    expect(link?.getAttribute("href")).toContain("/proposals/");
  });

  it("shows 'No activity' when activity list is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return jsonResponse({ items: [] });
    });
    renderDashboard();
    await waitFor(() => {
      expect(screen.queryByText("Loading activity...")).toBeNull();
    });
    expect(screen.getByText("No activity in the store.")).toBeDefined();
  });
});
