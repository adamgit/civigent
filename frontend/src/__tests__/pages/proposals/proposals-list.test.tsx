import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { Proposal } from "../../../types/shared";
import { ProposalsPage } from "../../../pages/ProposalsPage";

const sampleProposals: Proposal[] = [
  {
    id: "prop-1",
    kind: "agent_write",
    writer: { id: "agent-1", type: "agent", displayName: "Agent Alpha" },
    intent: "Improve overview clarity",
    status: "committed",
    sections: [{ doc_path: "ops/strategy.md", heading_path: ["Overview"], content: "Updated.\n" }],
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "prop-2",
    kind: "human_reservation",
    writer: { id: "human-1", type: "human", displayName: "Alice" },
    intent: "Refactor goals section",
    status: "pending",
    sections: [{ doc_path: "ops/strategy.md", heading_path: ["Goals"], content: "Goals.\n" }],
    created_at: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "prop-3",
    kind: "agent_write",
    writer: { id: "agent-2", type: "agent", displayName: "Agent Beta" },
    intent: "Add design notes",
    status: "withdrawn",
    sections: [],
    created_at: "2026-01-03T00:00:00.000Z",
    withdrawal_reason: "Superseded",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

function renderProposals() {
  return render(
    <MemoryRouter>
      <ProposalsPage />
    </MemoryRouter>,
  );
}

describe("ProposalsPage list", () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/proposals")) {
        return jsonResponse({ proposals: sampleProposals });
      }
      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches proposals on mount", async () => {
    renderProposals();
    await waitFor(() => {
      expect(screen.queryByText("Loading proposals...")).toBeNull();
    });
    expect(screen.getByText("prop-1")).toBeDefined();
  });

  it("renders proposal cards with ID, intent, status, writer", async () => {
    renderProposals();
    await waitFor(() => {
      expect(screen.getByText("prop-1")).toBeDefined();
    });
    expect(screen.getByText(/Improve overview clarity/)).toBeDefined();
    expect(screen.getByText(/Agent Alpha/)).toBeDefined();
  });

  it("status filter changes API call parameter", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/proposals") && urlStr.includes("status=pending")) {
        return jsonResponse({ proposals: [sampleProposals[1]] });
      }
      if (urlStr.includes("/api/proposals")) {
        return jsonResponse({ proposals: sampleProposals });
      }
      return jsonResponse({});
    });

    renderProposals();
    await waitFor(() => {
      expect(screen.getByText("prop-1")).toBeDefined();
    });

    const statusSelect = screen.getByLabelText(/Status:/);
    fireEvent.change(statusSelect, { target: { value: "pending" } });

    await waitFor(() => {
      expect(screen.getByText("prop-2")).toBeDefined();
    });
  });

  it("writer type filter filters displayed proposals", async () => {
    renderProposals();
    await waitFor(() => {
      expect(screen.getByText("prop-1")).toBeDefined();
    });

    const writerSelect = screen.getByLabelText(/Writer:/);
    fireEvent.change(writerSelect, { target: { value: "human" } });

    expect(screen.getByText("prop-2")).toBeDefined();
    expect(screen.queryByText("prop-1")).toBeNull();
    expect(screen.queryByText("prop-3")).toBeNull();
  });

  it("search input filters by proposal ID or intent text", async () => {
    renderProposals();
    await waitFor(() => {
      expect(screen.getByText("prop-1")).toBeDefined();
    });

    const searchInput = screen.getByPlaceholderText("proposal id or intent");
    fireEvent.change(searchInput, { target: { value: "design" } });

    expect(screen.getByText("prop-3")).toBeDefined();
    expect(screen.queryByText("prop-1")).toBeNull();
    expect(screen.queryByText("prop-2")).toBeNull();
  });

  it("clicking proposal navigates to /proposals/:id", async () => {
    renderProposals();
    await waitFor(() => {
      expect(screen.getByText("prop-1")).toBeDefined();
    });

    const link = screen.getByText("prop-1").closest("a");
    expect(link?.getAttribute("href")).toBe("/proposals/prop-1");
  });

  it("shows empty state when no proposals match filter", async () => {
    renderProposals();
    await waitFor(() => {
      expect(screen.getByText("prop-1")).toBeDefined();
    });

    const searchInput = screen.getByPlaceholderText("proposal id or intent");
    fireEvent.change(searchInput, { target: { value: "nonexistent-term" } });

    expect(screen.getByText("No proposals found.")).toBeDefined();
  });

  it("shows empty state when no proposals exist", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return jsonResponse({ proposals: [] });
    });

    renderProposals();
    await waitFor(() => {
      expect(screen.getByText("No proposals found.")).toBeDefined();
    });
  });
});
