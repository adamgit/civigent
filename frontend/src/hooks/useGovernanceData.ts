import { useMemo } from "react";
import type { WorkspaceSectionDto } from "../pages/document-page-utils";
import type {
  GovernanceSectionControl,
  GovernanceInProgressProposal,
  HumanInvolvementSectionDetails,
  AgentTier,
  GateRule,
} from "../components/GovernanceLeftGutter";
import type { SectionAuditGroup } from "../components/GovernanceRightGutter";

// ─── Human-involvement-policy-specific tiering ───────────────────
//
// These helpers are NOT part of the generic governance path. They are only
// invoked when a section's agent-write-policy summary carries the
// human-involvement compatibility policy's `humanInvolvement.score` detail
// (spec 12: common code must never assume a score/threshold/tier/gate exists).

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

/**
 * Derive the human-involvement-policy detail block from the 0..1 score the
 * section summary surfaces. Returns `undefined` for the generic path (no score).
 */
function deriveHumanInvolvementDetails(
  rawScore: number | undefined,
): HumanInvolvementSectionDetails | undefined {
  if (typeof rawScore !== "number") return undefined;
  const involvementScore = Math.round(rawScore * 100);
  const agentTier = computeAgentTier(involvementScore);
  return {
    involvementScore,
    agentTier,
    gates: GATES_BY_TIER[agentTier],
    tierTransitionNote: TIER_TRANSITION_NOTES[agentTier] || undefined,
  };
}

// ─── Backend-authored prose (Area O / MW-11) ─────────────────────
//
// The section-level summary now carries a backend-authored prose `message`
// (`SectionAgentWritePolicySummary.message`). Clients render it verbatim rather
// than synthesizing a line from `canWrite`. We keep a policy-agnostic fallback
// only for the degenerate case of a section with no policy summary at all.

const FALLBACK_POLICY_MESSAGE = "Agents can currently write to this section.";

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

export type { GovernanceInProgressProposal } from "../components/GovernanceLeftGutter";

export interface UseGovernanceDataOptions {
  /** The CENTER column's ordered section identity list (fragment keys): live
   *  topology order when the replica is ready, workspace REST order when cold.
   *  When provided, gutter rows iterate exactly this list — REST metadata is
   *  looked up by fragment key, never joined by array position. */
  orderedFragmentKeys?: readonly string[];
  /** Section-keyed in-progress proposal facts (see the page's lookup). */
  inProgressByFragmentKey?: ReadonlyMap<string, GovernanceInProgressProposal>;
}

export function useGovernanceData(
  sections: WorkspaceSectionDto[],
  opts?: UseGovernanceDataOptions,
): {
  leftGutterSections: GovernanceSectionControl[];
  rightGutterGroups: SectionAuditGroup[];
} {
  const orderedFragmentKeys = opts?.orderedFragmentKeys;
  const inProgressByFragmentKey = opts?.inProgressByFragmentKey;
  return useMemo(() => {
    const buildControl = (
      fragmentKey: string,
      section: WorkspaceSectionDto | undefined,
    ): GovernanceSectionControl => {
      const inProgressProposal = inProgressByFragmentKey?.get(fragmentKey) ?? false;
      if (!section) {
        // A key the center shows but REST metadata does not know yet (e.g. a
        // section minted live this session). Its identity IS the fragment key;
        // only the REST-sourced metadata is absent.
        return {
          fragmentKey,
          heading: "",
          canWrite: true,
          message: FALLBACK_POLICY_MESSAGE,
          lastEditorNote: "",
          humanInvolvement: undefined,
          inProgressProposal,
        };
      }
      const policy = section.agentWritePolicy;
      const canWrite = policy?.canWrite ?? true;
      const message = policy?.message ?? FALLBACK_POLICY_MESSAGE;
      const humanInvolvement = deriveHumanInvolvementDetails(
        policy?.humanInvolvement?.score,
      );
      const heading = section.heading_path.length > 0
        ? section.heading_path[section.heading_path.length - 1]
        : "";

      const lastEditor = section.last_editor;
      const rawLastEditorType = lastEditor?.type as string | undefined;
      const lastEditorKind = rawLastEditorType === "human"
        ? "Human"
        : rawLastEditorType === "agent"
          ? "Agent"
          : `UNKNOWN(${rawLastEditorType ?? "(missing)"})`;
      const lastEditorNote = lastEditor
        ? `${lastEditor.name} [${lastEditorKind}] edited ${formatRelativeTime(lastEditor.timestampMs)}`
        : "";

      return {
        fragmentKey,
        heading,
        canWrite,
        message,
        lastEditorNote,
        humanInvolvement,
        inProgressProposal,
      };
    };

    // One ordered identity list shared with the center column: when the caller
    // supplies the center's order (live topology when ready, cold REST order
    // otherwise), REST metadata is looked up by fragment key — never joined by
    // array position — and sections the center no longer shows drop out.
    // Without a supplied order, the REST rows themselves are the list.
    let leftGutterSections: GovernanceSectionControl[];
    let rightGutterGroups: SectionAuditGroup[];
    if (orderedFragmentKeys) {
      const byFragmentKey = new Map<string, WorkspaceSectionDto>();
      for (const section of sections) byFragmentKey.set(section.fragment_key, section);
      leftGutterSections = orderedFragmentKeys.map(
        (fragmentKey) => buildControl(fragmentKey, byFragmentKey.get(fragmentKey)),
      );
      rightGutterGroups = orderedFragmentKeys.map((fragmentKey) => ({
        fragmentKey,
        entries: [],
        inProgressProposal: inProgressByFragmentKey?.get(fragmentKey) ?? false,
      }));
    } else {
      leftGutterSections = sections.map((s) => buildControl(s.fragment_key, s));
      rightGutterGroups = sections.map((s) => ({
        fragmentKey: s.fragment_key,
        entries: [],
        inProgressProposal: inProgressByFragmentKey?.get(s.fragment_key) ?? false,
      }));
    }

    return { leftGutterSections, rightGutterGroups };
  }, [sections, orderedFragmentKeys, inProgressByFragmentKey]);
}
