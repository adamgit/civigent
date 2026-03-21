import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminPage } from "../../../pages/AdminPage";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { AnyProposal } from "../../../types/shared";

const sampleProposals: AnyProposal[] = [
  {
    id: "prop-1",
    kind: "agent_write",
    writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
    intent: "Update docs",
    status: "pending",
    sections: [],
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "prop-2",
    kind: "agent_write",
    writer: { id: "agent-2", type: "agent", displayName: "Agent B" },
    intent: "Add content",
    status: "committed",
    sections: [],
    created_at: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "prop-3",
    kind: "agent_write",
    writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
    intent: "Remove section",
    status: "withdrawn",
    sections: [],
    created_at: "2026-01-03T00:00:00.000Z",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

function defaultFetch(url: unknown) {
  const urlStr = String(url);
  if (urlStr.includes("/api/health")) {
    return jsonResponse({ ok: true });
  }
  if (urlStr.includes("/api/admin/snapshot-health")) {
    return jsonResponse({ status: "ok", documents: 5, sessions: 2 });
  }
  if (urlStr.includes("/api/admin/config")) {
    return jsonResponse({
      humanInvolvement_preset: "eager",
      humanInvolvement_midpoint_seconds: 7200,
      humanInvolvement_steepness: 1,
    });
  }
  if (urlStr.includes("/api/proposals")) {
    return jsonResponse({ proposals: sampleProposals });
  }
  if (urlStr.includes("/api/auth/session")) {
    return jsonResponse({
      authenticated: true,
      user: { id: "human-ui", type: "human", displayName: "Test User" },
    });
  }
  if (urlStr.includes("/api/activity")) {
    return jsonResponse({ items: [{ sections: [] }, { sections: [] }, { sections: [] }] });
  }
  return jsonResponse({});
}

function renderAdmin() {
  return render(
    <MemoryRouter>
      <AdminPage />
    </MemoryRouter>,
  );
}

describe("AdminPage", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn().mockImplementation(async (url: unknown) => defaultFetch(url));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("shows backend health status", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.getByText(/Backend health: ok/)).toBeDefined();
    });
  });

  it("shows proposal counts (pending, committed, withdrawn)", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.getByText(/Proposals total: 3/)).toBeDefined();
    });
    expect(screen.getByText(/Pending proposals: 1/)).toBeDefined();
    expect(screen.getByText(/Committed proposals: 1/)).toBeDefined();
    expect(screen.getByText(/Withdrawn proposals: 1/)).toBeDefined();
  });

  it("shows current writer ID from session info", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.getByText(/human-ui/)).toBeDefined();
    });
  });

  it("shows snapshot health status", async () => {
    // Snapshot health is fetched; presence of section heading confirms it loaded
    renderAdmin();
    await waitFor(() => {
      expect(screen.queryByText("Loading operational snapshot...")).toBeNull();
    });
    // The API was called
    const snapshotCalls = fetchMock.mock.calls.filter(
      (call: [unknown]) => String(call[0]).includes("/api/admin/snapshot-health"),
    );
    expect(snapshotCalls.length).toBeGreaterThan(0);
  });

  it("shows activity count", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.getByText(/Recent activity items.*3/)).toBeDefined();
    });
  });

  it("refresh button re-fetches data", async () => {
    renderAdmin();
    await waitFor(() => {
      expect(screen.queryByText("Loading operational snapshot...")).toBeNull();
    });

    const initialCalls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByText("Refresh snapshot"));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it("shows error state when API fails", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("Server error");
    });

    renderAdmin();
    await waitFor(() => {
      expect(screen.getByText(/Server error/)).toBeDefined();
    });
  });
});
