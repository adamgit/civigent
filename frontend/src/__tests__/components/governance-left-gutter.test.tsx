import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GovernanceLeftGutter } from "../../components/GovernanceLeftGutter";
import type { GovernanceSectionControl } from "../../components/GovernanceLeftGutter";

function genericSection(overrides: Partial<GovernanceSectionControl> = {}): GovernanceSectionControl {
  return {
    fragmentKey: "frag:sec_overview",
    heading: "Overview",
    canWrite: true,
    message: "Agents can currently write to this section.",
    lastEditorNote: "",
    ...overrides,
  };
}

describe("GovernanceLeftGutter", () => {
  it("renders the generic allowed badge + backend prose, with no involvement bar/tier/gates when no policy details", () => {
    const { container } = render(
      <GovernanceLeftGutter sections={[genericSection({ canWrite: true })]} />,
    );
    expect(screen.getByText("Agents can write")).toBeDefined();
    expect(screen.getByText("Agents can currently write to this section.")).toBeDefined();
    // Policy-specific visuals must be absent.
    expect(container.querySelector(".gov-involvement")).toBeNull();
    expect(container.querySelector(".gov-agent-tier")).toBeNull();
    expect(container.querySelector(".gov-gate-list")).toBeNull();
  });

  it("renders a blocked badge with prose when canWrite is false", () => {
    render(
      <GovernanceLeftGutter
        sections={[genericSection({ canWrite: false, message: "Agents are currently blocked from writing to this section." })]}
      />,
    );
    expect(screen.getByText("Agents blocked")).toBeDefined();
    expect(screen.getByText("Agents are currently blocked from writing to this section.")).toBeDefined();
  });

  it("renders the involvement bar, tier, and gate checklist when human-involvement details are present", () => {
    const { container } = render(
      <GovernanceLeftGutter
        sections={[genericSection({
          canWrite: true,
          humanInvolvement: {
            involvementScore: 40,
            agentTier: "gated",
            gates: [{ label: "Reads: auto-approved", active: true }],
            tierTransitionNote: "Opens to auto when score drops below 30%",
          },
        })]}
      />,
    );
    expect(container.querySelector(".gov-involvement")).not.toBeNull();
    expect(container.querySelector(".gov-agent-tier")).not.toBeNull();
    expect(container.querySelector(".gov-gate-list")).not.toBeNull();
    expect(screen.getByText("Reads: auto-approved")).toBeDefined();
  });

  it("shows the restrict-agents affordance only for auto-tier human-involvement details, and fires the callback", () => {
    const onRestrictAgents = vi.fn();
    render(
      <GovernanceLeftGutter
        onRestrictAgents={onRestrictAgents}
        sections={[genericSection({
          fragmentKey: "frag:sec_auto",
          humanInvolvement: { involvementScore: 5, agentTier: "auto", gates: [] },
        })]}
      />,
    );
    const btn = screen.getByText("Override: restrict agents");
    fireEvent.click(btn);
    expect(onRestrictAgents).toHaveBeenCalledWith("frag:sec_auto");
  });

  it("does not render the restrict-agents affordance for the generic (no-details) path", () => {
    const onRestrictAgents = vi.fn();
    render(
      <GovernanceLeftGutter
        onRestrictAgents={onRestrictAgents}
        sections={[genericSection({})]}
      />,
    );
    expect(screen.queryByText("Override: restrict agents")).toBeNull();
  });
});
