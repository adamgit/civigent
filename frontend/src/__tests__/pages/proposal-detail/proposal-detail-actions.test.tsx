import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { AnyProposal } from "../../../types/shared";
import { ProposalDetailPage } from "../../../pages/ProposalDetailPage";

const pendingProposal: AnyProposal = {
  id: "prop-1",
  kind: "agent_write",
  writer: { id: "agent-1", type: "agent", displayName: "Agent Alpha" },
  intent: "Improve overview",
  status: "pending",
  sections: [
    {
      doc_path: "ops/strategy.md",
      heading_path: ["Overview"],
      content: "Updated.\n",
      humanInvolvement_score: 0.2,
      blocked: false,
    },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
};

const committedProposal: AnyProposal = {
  ...pendingProposal,
  id: "prop-committed",
  status: "committed",
  committed_head: "abc123",
};

let fetchMock: ReturnType<typeof vi.fn>;

function renderDetail(proposalId: string) {
  return render(
    <MemoryRouter initialEntries={[`/proposals/${proposalId}`]}>
      <Routes>
        <Route path="/proposals/:id" element={<ProposalDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProposalDetailPage actions", () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/proposals/prop-1/commit") && init?.method === "POST") {
        return jsonResponse({ status: "committed" });
      }
      if (urlStr.includes("/api/proposals/prop-1/withdraw") && init?.method === "POST") {
        return jsonResponse({ status: "withdrawn" });
      }
      if (urlStr.includes("/api/proposals/prop-1")) {
        return jsonResponse({ proposal: pendingProposal });
      }
      if (urlStr.includes("/api/proposals/prop-committed")) {
        return jsonResponse({ proposal: committedProposal });
      }
      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("'Recommit' button calls commitProposal for pending proposals", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText("Recommit")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Recommit"));

    await waitFor(() => {
      const commitCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/commit") && call[1]?.method === "POST",
      );
      expect(commitCalls.length).toBeGreaterThan(0);
    });
  });

  it("'Withdraw' button calls withdrawProposal for pending proposals", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText("Withdraw")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Withdraw"));

    await waitFor(() => {
      const withdrawCalls = fetchMock.mock.calls.filter(
        (call: [unknown, RequestInit?]) =>
          String(call[0]).includes("/withdraw") && call[1]?.method === "POST",
      );
      expect(withdrawCalls.length).toBeGreaterThan(0);
    });
  });

  it("action buttons disabled when proposal is committed", async () => {
    renderDetail("prop-committed");
    await waitFor(() => {
      expect(screen.getByText("Recommit")).toBeDefined();
    });

    const recommitBtn = screen.getByText("Recommit") as HTMLButtonElement;
    const withdrawBtn = screen.getByText("Withdraw") as HTMLButtonElement;
    expect(recommitBtn.disabled).toBe(true);
    expect(withdrawBtn.disabled).toBe(true);
  });

  it("'Refresh' button re-fetches proposal data", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeDefined();
    });

    const initialFetchCount = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialFetchCount);
    });
  });
});
