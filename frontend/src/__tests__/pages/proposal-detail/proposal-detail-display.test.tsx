import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { AnyProposal } from "../../../types/shared";
import { ProposalDetailPage } from "../../../pages/ProposalDetailPage";

const pendingProposal: AnyProposal = {
  id: "prop-1",
  kind: "agent_write",
  writer: { id: "agent-1", type: "agent", displayName: "Agent Alpha" },
  intent: "Improve overview clarity",
  status: "draft",
  sections: [
    {
      doc_path: "ops/strategy.md",
      heading_path: ["Overview"],
      content: "Updated overview.\n",
      humanInvolvement_score: 0.35,
      blocked: false,
    },
    {
      doc_path: "ops/strategy.md",
      heading_path: ["Goals"],
      content: "Updated goals.\n",
      humanInvolvement_score: 0.65,
      blocked: true,
      block_reason: "involvement_threshold",
    },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
  humanInvolvement_evaluation: {
    all_sections_accepted: false,
    aggregate_impact: 0.5,
    aggregate_threshold: 0.8,
    blocked_sections: [
      {
        doc_path: "ops/strategy.md",
        heading_path: ["Goals"],
        humanInvolvement_score: 0.65,
        blocked: true,
        block_reason: "involvement_threshold",
      },
    ],
    passed_sections: [
      {
        doc_path: "ops/strategy.md",
        heading_path: ["Overview"],
        humanInvolvement_score: 0.35,
        blocked: false,
      },
    ],
  },
};

const committedProposal: AnyProposal = {
  ...pendingProposal,
  id: "prop-2",
  status: "committed",
  committed_head: "abc123def",
};

function renderDetail(proposalId: string) {
  return render(
    <MemoryRouter initialEntries={[`/proposals/${proposalId}`]}>
      <Routes>
        <Route path="/proposals/:id" element={<ProposalDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProposalDetailPage display", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/proposals/prop-1")) {
        return jsonResponse({ proposal: pendingProposal });
      }
      if (urlStr.includes("/api/proposals/prop-2")) {
        return jsonResponse({ proposal: committedProposal });
      }
      if (urlStr.includes("/api/proposals/nonexistent")) {
        return new Response(JSON.stringify({ message: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches proposal on mount", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.queryByText("Loading proposal...")).toBeNull();
      expect(screen.getByText(/pending/)).toBeDefined();
    });
  });

  it("shows proposal metadata: status, writer, intent", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText(/Agent Alpha/)).toBeDefined();
      expect(screen.getByText(/Improve overview clarity/)).toBeDefined();
    });
  });

  it("shows committed_head when status is committed", async () => {
    renderDetail("prop-2");
    await waitFor(() => {
      expect(screen.getByText("abc123def")).toBeDefined();
    });
  });

  it("lists sections with doc_path and heading_path", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText("Overview")).toBeDefined();
      expect(screen.getByText("Goals")).toBeDefined();
    });
  });

  it("sections show human-involvement score", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText("0.35")).toBeDefined();
      expect(screen.getByText("0.65")).toBeDefined();
    });
  });

  it("blocked sections show block reason", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText(/involvement_threshold/)).toBeDefined();
    });
  });

  it("shows human-involvement evaluation summary", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText(/Human Involvement Evaluation/)).toBeDefined();
      expect(screen.getByText(/Blocked sections: 1/)).toBeDefined();
      expect(screen.getByText(/Passed sections: 1/)).toBeDefined();
    });
  });

  it("shows error for non-existent proposal", async () => {
    renderDetail("nonexistent");
    await waitFor(() => {
      expect(screen.getByText(/Not found/)).toBeDefined();
    });
  });
});
