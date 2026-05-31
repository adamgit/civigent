import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { DraftProposalDTO, CommittedProposalDomain } from "../../../types/shared";
import { ProposalDetailPage } from "../../../pages/ProposalDetailPage";

const pendingProposal: DraftProposalDTO = {
  id: "prop-1",
  writer: { id: "agent-1", type: "agent", displayName: "Agent Alpha" },
  intent: "Improve overview clarity",
  status: "draft",
  sections: [
    {
      doc_path: "ops/strategy.md",
      heading_path: ["Overview"],
    },
    {
      doc_path: "ops/strategy.md",
      heading_path: ["Goals"],
    },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
  agentWritePolicy: {
    canWrite: false,
    message: "One or more sections are blocked under the human-involvement policy.",
    details: { aggregateImpact: 0.5, aggregateThreshold: 0.8 },
    targets: [
      {
        target: { doc_path: "ops/strategy.md", heading_path: ["Overview"] },
        canWrite: true,
        message: "Agents may write to this section.",
        details: { score: 0.35, blockedReason: null, justification: null },
      },
      {
        target: { doc_path: "ops/strategy.md", heading_path: ["Goals"] },
        canWrite: false,
        message: "Recent human activity makes this section off-limits to agents.",
        details: { score: 0.65, blockedReason: "aggregate_impact", justification: null },
      },
    ],
  },
};

const committedProposal: CommittedProposalDomain = {
  id: "prop-2",
  writer: { id: "agent-1", type: "agent", displayName: "Agent Alpha" },
  intent: "Improve overview clarity",
  status: "committed",
  sections: [
    { doc_path: "ops/strategy.md", heading_path: ["Overview"] },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
  committed_head: "abc123def",
  humanInvolvement_at_commit: {},
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
      expect(screen.getByText("draft")).toBeDefined();
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

  it("sections show the human-involvement score when the policy provides it", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText("0.35")).toBeDefined();
      expect(screen.getByText("0.65")).toBeDefined();
    });
  });

  it("renders the backend prose explanation, not a reason code", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText("Recent human activity makes this section off-limits to agents.")).toBeDefined();
    });
    // The internal blockedReason enum must never be surfaced.
    expect(screen.queryByText(/aggregate_impact/)).toBeNull();
  });

  it("blocked sections are marked Blocked from canWrite", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText("Blocked")).toBeDefined();
      expect(screen.getAllByText("Allowed").length).toBeGreaterThan(0);
    });
  });

  it("shows the agent-write-policy summary", async () => {
    renderDetail("prop-1");
    await waitFor(() => {
      expect(screen.getByText(/Agent Write Policy/)).toBeDefined();
      expect(screen.getByText(/Blocked sections: 1/)).toBeDefined();
      expect(screen.getByText(/Allowed sections: 1/)).toBeDefined();
    });
  });

  it("shows error for non-existent proposal", async () => {
    renderDetail("nonexistent");
    await waitFor(() => {
      expect(screen.getByText(/Not found/)).toBeDefined();
    });
  });
});
