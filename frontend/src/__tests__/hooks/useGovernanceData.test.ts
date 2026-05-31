import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGovernanceData } from "../../hooks/useGovernanceData";
import type { DocumentSection } from "../../pages/document-page-utils";

function makeSection(overrides: Partial<DocumentSection>): DocumentSection {
  return {
    heading: "Overview",
    heading_path: ["Overview"],
    depth: 1,
    content: "# Overview\n",
    agentWritePolicy: { canWrite: true, message: "Agents can currently write to Overview." },
    crdt_session_active: false,
    section_length_warning: false,
    word_count: 2,
    fragment_key: "frag:sec_overview",
    section_file: "sec_overview.md",
    ...overrides,
  };
}

describe("useGovernanceData", () => {
  it("renders the backend-authored blocked prose verbatim (MW-11)", () => {
    const sections = [
      makeSection({
        agentWritePolicy: {
          canWrite: false,
          message: "Agents are currently blocked from writing to Overview because a human was active too recently.",
        },
      }),
    ];
    const { result } = renderHook(() => useGovernanceData(sections));
    const control = result.current.leftGutterSections[0];

    expect(control.canWrite).toBe(false);
    // The message is the backend prose verbatim, NOT a client-synthesized line.
    expect(control.message).toBe(
      "Agents are currently blocked from writing to Overview because a human was active too recently.",
    );
    expect(control.heading).toBe("Overview");
    // No human-involvement score → no synthesized tier/score/gates.
    expect(control.humanInvolvement).toBeUndefined();
  });

  it("renders the backend-authored allowed prose verbatim and no policy details when no score is present (MW-11)", () => {
    const sections = [
      makeSection({
        agentWritePolicy: { canWrite: true, message: "Agents can currently write to Overview: human activity is low." },
      }),
    ];
    const { result } = renderHook(() => useGovernanceData(sections));
    const control = result.current.leftGutterSections[0];

    expect(control.canWrite).toBe(true);
    expect(control.message).toBe("Agents can currently write to Overview: human activity is low.");
    expect(control.humanInvolvement).toBeUndefined();
  });

  it("falls back to a generic line only when a section carries no policy summary at all", () => {
    const sections = [
      makeSection({ agentWritePolicy: undefined as unknown as DocumentSection["agentWritePolicy"] }),
    ];
    const { result } = renderHook(() => useGovernanceData(sections));
    const control = result.current.leftGutterSections[0];
    expect(control.canWrite).toBe(true);
    expect(control.message).toMatch(/can currently write/i);
  });

  it("surfaces typed human-involvement details (score/tier/gates) only when the policy provides a score", () => {
    const sections = [
      // 0.65 → blocked tier (>= 0.50), 0.40 → gated tier (>= 0.30), 0.10 → auto tier.
      makeSection({ agentWritePolicy: { canWrite: false, message: "blocked", humanInvolvement: { score: 0.65 } } }),
      makeSection({ heading: "Goals", heading_path: ["Goals"], agentWritePolicy: { canWrite: true, message: "ok", humanInvolvement: { score: 0.4 } } }),
      makeSection({ heading: "Detail", heading_path: ["Detail"], agentWritePolicy: { canWrite: true, message: "ok", humanInvolvement: { score: 0.1 } } }),
    ];
    const { result } = renderHook(() => useGovernanceData(sections));
    const [blocked, gated, auto] = result.current.leftGutterSections;

    expect(blocked.humanInvolvement).toBeDefined();
    expect(blocked.humanInvolvement!.involvementScore).toBe(65);
    expect(blocked.humanInvolvement!.agentTier).toBe("blocked");
    expect(blocked.humanInvolvement!.gates).toHaveLength(0);

    expect(gated.humanInvolvement!.agentTier).toBe("gated");
    expect(gated.humanInvolvement!.gates.length).toBeGreaterThan(0);
    expect(gated.humanInvolvement!.tierTransitionNote).toBeDefined();

    expect(auto.humanInvolvement!.agentTier).toBe("auto");
    expect(auto.humanInvolvement!.involvementScore).toBe(10);
  });

  it("keeps the policy-independent lastEditorNote", () => {
    const sections = [
      makeSection({
        last_editor: {
          id: "u1",
          name: "Alice",
          timestampMs: Date.now() - 5000,
          type: "human",
          seconds_ago: 5,
        },
      }),
    ];
    const { result } = renderHook(() => useGovernanceData(sections));
    const control = result.current.leftGutterSections[0];
    expect(control.lastEditorNote).toMatch(/Alice/);
    expect(control.lastEditorNote).toMatch(/Human/);
  });

  it("produces one rightGutterGroup per section", () => {
    const sections = [makeSection({}), makeSection({ heading: "Goals", heading_path: ["Goals"] })];
    const { result } = renderHook(() => useGovernanceData(sections));
    expect(result.current.rightGutterGroups).toHaveLength(2);
    expect(result.current.rightGutterGroups[0]).toEqual({ sectionIndex: 0, entries: [] });
    expect(result.current.rightGutterGroups[1]).toEqual({ sectionIndex: 1, entries: [] });
  });
});
