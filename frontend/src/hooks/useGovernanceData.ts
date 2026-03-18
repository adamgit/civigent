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
  blockedAbove: 50,
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
    { label: "Content updates: auto + audit log", active: true },
  ],
};

const TIER_TRANSITION_NOTES: Record<AgentTier, string> = {
  blocked: "Opens to gated writes when score drops below 50%",
  gated: "Opens to auto when score drops below 30%",
  auto: "",
};

// ─── Relative time helper ─────────────────────────────────────────

function formatRelativeTime(timestampMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

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

        const lastEditor = section.last_human_editor;
        const lastEditorNote = lastEditor
          ? `${lastEditor.name} edited ${formatRelativeTime(lastEditor.timestampMs)}`
          : "";

        return {
          sectionIndex: i,
          heading,
          involvementScore,
          agentTier: tier,
          lastEditorNote,
          gates: GATES_BY_TIER[tier],
          tierTransitionNote: TIER_TRANSITION_NOTES[tier] || undefined,
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
