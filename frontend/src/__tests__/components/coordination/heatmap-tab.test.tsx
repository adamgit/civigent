import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HeatmapTab, type AgentReadingState } from "../../../components/coordination/HeatmapTab";
import type { GetHeatmapResponse, HeatmapEntry } from "../../../types/shared";

function entry(overrides: Partial<HeatmapEntry>): HeatmapEntry {
  return {
    doc_path: "ops/strategy.md",
    heading_path: ["Overview"],
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to this section." },
    crdt_session_active: false,
    last_human_commit_sha: null,
    last_commit_author: null,
    last_commit_timestamp: null,
    ...overrides,
  };
}

function renderTab(heatmap: GetHeatmapResponse | null) {
  return render(
    <MemoryRouter>
      <HeatmapTab
        heatmap={heatmap}
        agentReadings={new Map<string, AgentReadingState>()}
        proposals={[]}
        loading={false}
        error={null}
      />
    </MemoryRouter>,
  );
}

describe("HeatmapTab", () => {
  it("renders the generic agent-write status column (no score/preset) for a policy without score details", () => {
    const heatmap: GetHeatmapResponse = {
      preset: "eager",
      humanInvolvement_midpoint_seconds: 7200,
      humanInvolvement_steepness: 1.2,
      sections: [
        entry({ heading_path: ["Overview"], agentWritePolicy: { canWrite: true, message: "Agents can currently write to Overview." } }),
        entry({ heading_path: ["Goals"], agentWritePolicy: { canWrite: false, message: "Agents are currently blocked from writing to Goals." } }),
      ],
    };
    const { container } = renderTab(heatmap);

    expect(screen.getByText("Allowed")).toBeDefined();
    expect(screen.getByText("Blocked")).toBeDefined();
    // The "Agent writes" column header is the generic status.
    expect(screen.getByText("Agent writes")).toBeDefined();
    // No human-involvement column / preset header when no score detail present.
    expect(screen.queryByText("Human Involvement")).toBeNull();
    expect(container.textContent).not.toMatch(/Preset:/);
  });

  it("renders the score cell, status label, and preset header when the human-involvement policy is selected", () => {
    const heatmap: GetHeatmapResponse = {
      preset: "conservative",
      humanInvolvement_midpoint_seconds: 28800,
      humanInvolvement_steepness: 0.9,
      sections: [
        entry({ heading_path: ["Overview"], agentWritePolicy: { canWrite: false, message: "Agents blocked: human active too recently.", humanInvolvement: { score: 0.65 } } }),
      ],
    };
    const { container } = renderTab(heatmap);

    expect(screen.getByText("Human Involvement")).toBeDefined();
    expect(container.textContent).toMatch(/Preset:/);
    expect(container.textContent).toMatch(/conservative/);
    // Score cell shows the numeric score + its policy label.
    expect(screen.getByText(/0\.65/)).toBeDefined();
    // The generic decision still renders.
    expect(screen.getByText("Blocked")).toBeDefined();
  });

  it("never renders a bare reason code/enum as the admin-facing explanation", () => {
    const heatmap: GetHeatmapResponse = {
      preset: "eager",
      humanInvolvement_midpoint_seconds: 7200,
      humanInvolvement_steepness: 1.2,
      sections: [entry({ agentWritePolicy: { canWrite: false, message: "Agents are currently blocked from writing here." } })],
    };
    const { container } = renderTab(heatmap);
    expect(container.textContent).not.toMatch(/aggregate_impact|human_proposal_lock/);
  });

  it("exposes the backend-authored prose as the status cell's tooltip (MW-11)", () => {
    const heatmap: GetHeatmapResponse = {
      preset: "eager",
      humanInvolvement_midpoint_seconds: 7200,
      humanInvolvement_steepness: 1.2,
      sections: [
        entry({
          heading_path: ["Overview"],
          agentWritePolicy: { canWrite: false, message: "Agents are currently blocked from writing to Overview because a human was active too recently." },
        }),
      ],
    };
    renderTab(heatmap);
    const cell = screen.getByText("Blocked").closest("td");
    expect(cell?.getAttribute("title")).toBe(
      "Agents are currently blocked from writing to Overview because a human was active too recently.",
    );
  });

  it("shows an empty state when there are no sections", () => {
    renderTab({ preset: "eager", humanInvolvement_midpoint_seconds: 7200, humanInvolvement_steepness: 1.2, sections: [] });
    expect(screen.getByText("No sections found.")).toBeDefined();
  });
});
