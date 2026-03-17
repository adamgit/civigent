import { useMemo } from "react";
import type { DocumentSection } from "../pages/document-page-utils";
import type {
  GovernanceSectionControl,
  AgentTier,
  GateRule,
} from "../components/GovernanceLeftGutter";
import type { SectionAuditGroup } from "../components/GovernanceRightGutter";

// ─── Tier thresholds (configurable per-org in the future) ────────

interface TierThresholds {
  blockedAbove: number;
  gatedAbove: number;
}

const DEFAULT_THRESHOLDS: TierThresholds = {
  blockedAbove: 70,
  gatedAbove: 30,
};

function computeAgentTier(
  score: number,
  thresholds: TierThresholds = DEFAULT_THRESHOLDS,
): AgentTier {
  if (score >= thresholds.blockedAbove) return "blocked";
  if (score >= thresholds.gatedAbove) return "gated";
  return "auto";
}

const GATES_BY_TIER: Record<AgentTier, GateRule[]> = {
  blocked: [],
  gated: [
    { label: "Reads: auto-approved", active: true },
    { label: "Bounded writes: auto + monitoring", active: true },
    { label: "Section restructure: requires approval", active: false },
    { label: "Delete content: requires approval", active: false },
  ],
  auto: [
    { label: "All reads: auto", active: true },
    { label: "Content updates: auto + audit log", active: true },
    { label: "Pricing changes: auto + monitoring", active: true },
    { label: "Section restructure: requires approval", active: false },
  ],
};

const TIER_TRANSITION_NOTES: Record<AgentTier, string> = {
  blocked: "Opens to gated writes when score drops below 70%",
  gated: "Opens to auto when score drops below 30%",
  auto: "",
};

// ─── Hook ────────────────────────────────────────────────────────

export function useGovernanceData(
  sections: DocumentSection[],
): {
  leftGutterSections: GovernanceSectionControl[];
  rightGutterGroups: SectionAuditGroup[];
} {
  return useMemo(() => {
    const leftGutterSections: GovernanceSectionControl[] = sections.map(
      (section, i) => {
        const rawScore = section.humanInvolvement_score ?? 0;
        const involvementScore = Math.round(rawScore * 100);
        const tier = computeAgentTier(involvementScore);
        const heading = section.heading_path.length > 0
          ? section.heading_path[section.heading_path.length - 1]
          : "";

        return {
          sectionIndex: i,
          heading,
          involvementScore,
          agentTier: tier,
          decayNote: "Score derived from recent edit history",
          gates: GATES_BY_TIER[tier],
          tierTransitionNote: TIER_TRANSITION_NOTES[tier] || undefined,
          signoffs: [],
          status: "draft" as const,
        };
      },
    );

    const rightGutterGroups: SectionAuditGroup[] = sections.map(
      (_, i) => ({
        sectionIndex: i,
        entries: [],
      }),
    );

    return { leftGutterSections, rightGutterGroups };
  }, [sections]);
}
