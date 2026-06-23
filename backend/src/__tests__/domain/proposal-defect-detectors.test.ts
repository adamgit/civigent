/**
 * Proposal defect detector registry — the `missing-targets` autofix re-derives the
 * authoritative `targets` claim set from `sections` and clears the marker. Pure
 * unit test (no disk): exercises detect()/fix() directly.
 */

import { describe, it, expect } from "vitest";
import {
  findProposalDefectDetector,
  PROPOSAL_DEFECT_DETECTORS,
} from "../../domain/proposal-defect-detectors.js";
import type { AnyProposal } from "../../types/shared.js";

const DEGRADED: AnyProposal = {
  id: "prop-1",
  writer: { id: "agent-1", type: "agent", displayName: "Agent A" },
  intent: "legacy",
  sections: [{ doc_path: "/notes.md", heading_path: ["Overview"] }],
  // Targets that a lenient decode derived from sections, plus the marker.
  targets: [{ kind: "section", doc_path: "/notes.md", heading_path: ["Overview"] }],
  degraded: ["missing-targets"],
  created_at: "2025-01-01T00:00:00.000Z",
  status: "draft",
};

describe("missing-targets detector", () => {
  const detector = findProposalDefectDetector("missing-targets");

  it("is registered", () => {
    expect(detector).toBeDefined();
    expect(PROPOSAL_DEFECT_DETECTORS.map((d) => d.id)).toContain("missing-targets");
  });

  it("detects a proposal tagged missing-targets, ignores a healthy one", () => {
    expect(detector!.detect(DEGRADED)).toBe(true);
    const healthy: AnyProposal = { ...DEGRADED, degraded: undefined };
    expect(detector!.detect(healthy)).toBe(false);
  });

  it("fix re-derives targets from sections and clears the marker", () => {
    const fixed = detector!.fix(DEGRADED);
    expect(fixed.degraded).toBeUndefined();
    expect(fixed.targets).toEqual([
      { kind: "section", doc_path: "/notes.md", heading_path: ["Overview"] },
    ]);
    // Pure — does not mutate the input.
    expect(DEGRADED.degraded).toEqual(["missing-targets"]);
  });

  it("findProposalDefectDetector returns undefined for an unknown id", () => {
    expect(findProposalDefectDetector("nope")).toBeUndefined();
  });
});
