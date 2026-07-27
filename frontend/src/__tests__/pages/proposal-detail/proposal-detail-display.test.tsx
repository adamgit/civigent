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
      doc_path: "/ops/strategy.md",
      heading_path: ["Overview"],
    },
    {
      doc_path: "/ops/strategy.md",
      heading_path: ["Goals"],
    },
  ],
  targets: [
    { kind: "section", doc_path: "/ops/strategy.md", heading_path: ["Overview"] },
    { kind: "section", doc_path: "/ops/strategy.md", heading_path: ["Goals"] },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
  agentWritePolicy: {
    canWrite: false,
    message: "One or more sections are blocked under the human-involvement policy.",
    details: { aggregateImpact: 0.5, aggregateThreshold: 0.8 },
    targets: [
      {
        target: { kind: "section", doc_path: "/ops/strategy.md", heading_path: ["Overview"] },
        canWrite: true,
        message: "Agents may write to this section.",
        details: { score: 0.35, blockedReason: null, justification: null },
      },
      {
        target: { kind: "section", doc_path: "/ops/strategy.md", heading_path: ["Goals"] },
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
    { doc_path: "/ops/strategy.md", heading_path: ["Overview"] },
  ],
  targets: [
    { kind: "section", doc_path: "/ops/strategy.md", heading_path: ["Overview"] },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
  committed_head: "abc123def",
  humanInvolvement_at_commit: {},
};

const missingTargetsProposal: CommittedProposalDomain = {
  id: "prop-degraded-missing",
  writer: { id: "agent-1", type: "agent", displayName: "Agent Alpha" },
  intent: "Legacy proposal",
  status: "committed",
  sections: [{ doc_path: "/ops/strategy.md", heading_path: ["Overview"] }],
  targets: [{ kind: "section", doc_path: "/ops/strategy.md", heading_path: ["Overview"] }],
  created_at: "2026-01-01T00:00:00.000Z",
  committed_head: "abc123def",
  humanInvolvement_at_commit: {},
  degraded: ["missing-targets"],
};

const emptyCommittedProposal: CommittedProposalDomain = {
  id: "prop-degraded-empty",
  writer: { id: "agent-1", type: "agent", displayName: "Agent Alpha" },
  intent: "Empty committed corruption",
  status: "committed",
  sections: [],
  targets: [],
  created_at: "2026-01-01T00:00:00.000Z",
  committed_head: "def456abc",
  humanInvolvement_at_commit: {},
  degraded: ["empty-committed"],
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
      if (urlStr.includes("/api/proposals/prop-degraded-missing")) {
        return jsonResponse({ proposal: missingTargetsProposal });
      }
      if (urlStr.includes("/api/proposals/prop-degraded-empty")) {
        return jsonResponse({ proposal: emptyCommittedProposal });
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

  it("degraded banner shows the raw defect token, no autofix/English semantics", async () => {
    renderDetail("prop-degraded-missing");
    await waitFor(() => {
      expect(screen.getByText("Degraded proposal")).toBeDefined();
    });
    // Raw code token verbatim — not translated into English.
    expect(screen.getByText("missing-targets")).toBeDefined();
    // No frontend autofix promise and no per-defect English semantics.
    expect(screen.queryByText(/autofix/i)).toBeNull();
    expect(screen.queryByText(/repairable/i)).toBeNull();
    expect(screen.queryByText(/non-autofixable/)).toBeNull();
  });

  it("committed degraded banner reads as a corrupt terminal record, no future lock/commit lifecycle", async () => {
    renderDetail("prop-degraded-empty");
    await waitFor(() => {
      expect(screen.getByText("Degraded proposal")).toBeDefined();
    });
    // Raw code token verbatim.
    expect(screen.getByText("empty-committed")).toBeDefined();
    // Terminal committed corruption: describe it as a corrupt terminal record.
    expect(screen.getByText(/corrupt terminal proposal record/)).toBeDefined();
    // Must NOT imply a future commit/lock lifecycle that is already impossible.
    expect(screen.queryByText(/cannot acquire locks/)).toBeNull();
    expect(screen.queryByText(/autofix/i)).toBeNull();
  });

  it("shows error for non-existent proposal", async () => {
    renderDetail("nonexistent");
    await waitFor(() => {
      expect(screen.getByText(/Not found/)).toBeDefined();
    });
  });
});
