import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { jsonResponse } from "../../helpers/fetch-mocks";
import type { AnyProposal } from "../../../types/shared";

vi.mock("../../../services/api-client", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    resolveWriterId: () => "test-user",
  };
});

import { ProposalPanel } from "../../../components/ProposalPanel";

const sampleProposal: AnyProposal = {
  id: "prop-1",
  kind: "human_reservation",
  writer: { id: "test-user", type: "human", display_name: "Test User" },
  intent: "Update strategy docs",
  status: "pending",
  sections: [
    { doc_path: "ops/strategy.md", heading_path: ["Overview"], content: "Updated.\n" },
  ],
  created_at: "2026-01-01T00:00:00.000Z",
  evaluation: null,
};

describe("ProposalPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const mockEnter = vi.fn();
  const mockExit = vi.fn();

  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/proposals") && init?.method === "POST" && urlStr.includes("/commit")) {
        return jsonResponse({ status: "committed" });
      }
      if (urlStr.includes("/api/proposals") && init?.method === "POST" && urlStr.includes("/cancel")) {
        return jsonResponse({ status: "withdrawn" });
      }
      if (urlStr.includes("/api/proposals") && init?.method === "POST") {
        return jsonResponse({ proposal_id: "prop-new" });
      }
      if (urlStr.includes("/api/proposals/")) {
        return jsonResponse({ proposal: sampleProposal });
      }
      return jsonResponse({});
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    mockEnter.mockClear();
    mockExit.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows 'Create Proposal' button when no active proposal", () => {
    render(
      <ProposalPanel
        activeProposalId={null}
        proposalMode={false}
        onEnterProposalMode={mockEnter}
        onExitProposalMode={mockExit}
      />,
    );
    expect(screen.getByText("Create Proposal")).toBeDefined();
  });

  it("creating a proposal requires intent field", () => {
    render(
      <ProposalPanel
        activeProposalId={null}
        proposalMode={false}
        onEnterProposalMode={mockEnter}
        onExitProposalMode={mockExit}
      />,
    );
    const createBtn = screen.getByText("Create Proposal");
    // Button should be disabled when intent is empty
    expect((createBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("active proposal panel shows documents with section names", async () => {
    render(
      <ProposalPanel
        activeProposalId="prop-1"
        proposalMode={true}
        onEnterProposalMode={mockEnter}
        onExitProposalMode={mockExit}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Active Proposal")).toBeDefined();
      expect(screen.getByText(/ops\/strategy.md/)).toBeDefined();
      expect(screen.getByText(/Overview/)).toBeDefined();
    });
  });

  it("'Publish' button calls commit and exits proposal mode", async () => {
    render(
      <ProposalPanel
        activeProposalId="prop-1"
        proposalMode={true}
        onEnterProposalMode={mockEnter}
        onExitProposalMode={mockExit}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Publish")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Publish"));

    await waitFor(() => {
      expect(mockExit).toHaveBeenCalled();
    });

    // Verify commit API was called
    const commitCalls = fetchMock.mock.calls.filter(
      (call: [unknown, RequestInit?]) =>
        String(call[0]).includes("/commit") &&
        call[1]?.method === "POST",
    );
    expect(commitCalls.length).toBeGreaterThan(0);
  });

  it("'Cancel' button calls cancel and exits proposal mode", async () => {
    render(
      <ProposalPanel
        activeProposalId="prop-1"
        proposalMode={true}
        onEnterProposalMode={mockEnter}
        onExitProposalMode={mockExit}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(mockExit).toHaveBeenCalled();
    });

    // Verify cancel API was called
    const cancelCalls = fetchMock.mock.calls.filter(
      (call: [unknown, RequestInit?]) =>
        String(call[0]).includes("/cancel") &&
        call[1]?.method === "POST",
    );
    expect(cancelCalls.length).toBeGreaterThan(0);
  });

  it("creating proposal calls onEnterProposalMode with new ID", async () => {
    render(
      <ProposalPanel
        activeProposalId={null}
        proposalMode={false}
        onEnterProposalMode={mockEnter}
        onExitProposalMode={mockExit}
      />,
    );

    const intentInput = screen.getByPlaceholderText("What do you intend to change?");
    fireEvent.change(intentInput, { target: { value: "My intent" } });
    fireEvent.click(screen.getByText("Create Proposal"));

    await waitFor(() => {
      expect(mockEnter).toHaveBeenCalledWith("prop-new");
    });
  });
});
