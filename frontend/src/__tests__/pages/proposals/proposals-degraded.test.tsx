/**
 * ProposalsPage highlights a degraded proposal and offers a per-defect "Autofix"
 * button that calls the admin autofix endpoint and clears the row's degraded
 * state on success.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ProposalsPage } from "../../../pages/ProposalsPage";
import { installFetchMock, jsonResponse, type InstalledFetchMock } from "../../helpers/fetch-mocks";

let fetchMock: InstalledFetchMock | undefined;

function proposal(id: string, opts: { degraded?: string[] } = {}) {
  // Degraded proposals are always non-terminal (terminal proposals are never
  // tagged); a healthy row can be any status, here a committed one.
  if (opts.degraded) {
    return {
      id,
      status: "draft",
      writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
      intent: `proposal ${id}`,
      sections: [{ doc_path: "/notes.md", heading_path: ["Overview"] }],
      targets: [{ kind: "section", doc_path: "/notes.md", heading_path: ["Overview"] }],
      degraded: opts.degraded,
      created_at: "2025-01-01T00:00:00.000Z",
    };
  }
  return {
    id,
    status: "committed",
    writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
    intent: `proposal ${id}`,
    sections: [{ doc_path: "/notes.md", heading_path: ["Overview"] }],
    targets: [{ kind: "section", doc_path: "/notes.md", heading_path: ["Overview"] }],
    created_at: "2025-01-01T00:00:00.000Z",
    committed_head: "abc",
    humanInvolvement_at_commit: {},
  };
}

function renderProposals() {
  return render(
    <MemoryRouter initialEntries={["/proposals"]}>
      <ProposalsPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
  vi.clearAllMocks();
});

describe("ProposalsPage degraded highlight + autofix", () => {
  it("highlights a degraded proposal and clears it after autofix", async () => {
    let autofixCalled = false;
    fetchMock = installFetchMock(async (input, init) => {
      const url = String(input);
      if (url.includes("/autofix/")) {
        autofixCalled = true;
        expect(init?.method).toBe("POST");
        expect(url).toContain("/api/admin/proposals/bad/autofix/missing-targets");
        return jsonResponse({ proposal: proposal("bad") }); // repaired: no `degraded`
      }
      if (url.includes("/api/proposals")) {
        return jsonResponse({ proposals: [proposal("bad", { degraded: ["missing-targets"] }), proposal("good")] });
      }
      return jsonResponse({});
    });

    renderProposals();

    // Banner + degraded row both surface the defect with autofix affordances.
    await waitFor(() => {
      expect(screen.getByTestId("proposals-admin-review-banner")).toBeTruthy();
      expect(screen.getByTestId("proposal-row-degraded")).toBeTruthy();
    });
    const buttons = screen.getAllByRole("button", { name: /Autofix missing-targets/i });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    // The healthy proposal is not degraded.
    expect(screen.getByTestId("proposal-row")).toBeTruthy();

    fireEvent.click(buttons[0]!);

    // After autofix the banner and degraded row clear together.
    await waitFor(() => {
      expect(screen.queryByTestId("proposal-row-degraded")).toBeNull();
      expect(screen.queryByTestId("proposals-admin-review-banner")).toBeNull();
    });
    expect(autofixCalled).toBe(true);
    expect(screen.queryByRole("button", { name: /Autofix missing-targets/i })).toBeNull();
  });
});
