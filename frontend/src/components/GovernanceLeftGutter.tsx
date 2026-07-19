/**
 * GovernanceLeftGutter — per-section control & agent policy column.
 *
 * Renders alongside the document body in governance mode. Each section answers
 * one generic, policy-agnostic question: "can agents currently write here?" —
 * driven by `canWrite` plus a backend-provided prose `message` as the primary
 * explanation (spec 12 §Event/API Surfaces; Area M: render prose, never map a
 * code/enum to a classification).
 *
 * Policy-specific visuals (the human-involvement score bar, agent-permission
 * tier, gate checklist, transition note, "restrict agents" override) render ONLY
 * when the selected policy supplies them via the optional `humanInvolvement`
 * details sub-object. Common code must never assume a score, tier, threshold, or
 * gate exists. A future posture/delegation policy would instead render its own
 * typed details.
 *
 * "Dumb" component — receives all data via props, no internal fetching.
 * Styles in governance-gutters.css (all prefixed gov-).
 */

import { useSectionHover } from "../contexts/sectionHoverUtils";

// ─── Human-involvement-policy-specific helper types ──────────────
//
// `AgentTier` / `GateRule` are NOT generic governance vocabulary; they exist
// only for the human-involvement compatibility policy and live under the
// optional `humanInvolvement` details sub-object. Do NOT introduce a shared
// policy-decision enum (spec 12: discriminate via typed details, not a union).

export type AgentTier = "blocked" | "gated" | "auto";

export interface GateRule {
  label: string;
  active: boolean;
}

/**
 * Optional, human-involvement-policy-specific details for one section. Present
 * only when the human-involvement compatibility policy is the selected policy.
 */
export interface HumanInvolvementSectionDetails {
  involvementScore: number;
  agentTier: AgentTier;
  gates: GateRule[];
  tierTransitionNote?: string;
}

// ─── Generic governance section control ──────────────────────────

/** The in-progress-proposal fact for one section, joined by fragment identity.
 *  Only fields the source signal actually carries are present — missing
 *  fields stay absent rather than being invented. */
export interface GovernanceInProgressProposal {
  proposalId?: string;
  writerDisplayName?: string;
  intent?: string;
}

export interface GovernanceSectionControl {
  /** Canonical section identity (opaque fragment key) — never a position. */
  fragmentKey: string;
  heading: string;
  /** Generic decision: may agents currently write here under the active policy? */
  canWrite: boolean;
  /** Backend-provided prose explanation — the primary, policy-agnostic message. */
  message: string;
  /** Policy-independent: last human/agent editor note. */
  lastEditorNote: string;
  /** Present only when the human-involvement compatibility policy is selected. */
  humanInvolvement?: HumanInvolvementSectionDetails;
  /** `false` when no in-progress proposal covers this section. */
  inProgressProposal: false | GovernanceInProgressProposal;
}

export interface GovernanceLeftGutterProps {
  sections: GovernanceSectionControl[];
  /**
   * Human-involvement-policy override affordance. Only rendered when a section
   * carries `humanInvolvement` details and is in the `auto` tier.
   */
  onRestrictAgents?: (fragmentKey: string) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────

const TIER_CONFIG: Record<AgentTier, { cssClass: string; icon: string; label: string }> = {
  blocked: { cssClass: "gov-agent-tier-blocked", icon: "✖", label: "Agents blocked — human involvement high" },
  gated:   { cssClass: "gov-agent-tier-gated",   icon: "◆", label: "Gated writes — deterministic checks" },
  auto:    { cssClass: "gov-agent-tier-auto",     icon: "✓", label: "Auto — low-risk reads & writes" },
};

// ─── Sub-components ──────────────────────────────────────────────

/** Badge for a section currently under an in-progress proposal. Renders the
 *  fact always; writer/intent lines only when the source signal carried them. */
function InProgressProposalBadge({ fact }: { fact: GovernanceInProgressProposal }) {
  return (
    <div data-testid="gov-inprogress-proposal">
      <div className="gov-inprogress-badge">
        <span>✎</span>
        <span>Proposal in progress</span>
      </div>
      {fact.writerDisplayName ? (
        <div className="gov-inprogress-detail">{fact.writerDisplayName}</div>
      ) : null}
      {fact.intent ? (
        <div className="gov-inprogress-detail">&ldquo;{fact.intent}&rdquo;</div>
      ) : null}
    </div>
  );
}

function InvolvementBar({ score }: { score: number }) {
  // 0% = green (low human involvement), 100% = red (high human involvement)
  // Continuous hue interpolation: 120° (green) → 0° (red)
  const hue = Math.round(120 - score * 1.2);
  const barColor = `hsl(${hue}, 60%, 38%)`;
  const pctColor = `hsl(${hue}, 60%, 34%)`;
  return (
    <div className="gov-involvement">
      <div className="gov-meta-label">Human involvement</div>
      <div className="gov-involvement-bar-row">
        <div className="gov-involvement-bar-outer">
          <div
            className="gov-involvement-bar-inner"
            style={{ width: `${score}%`, background: barColor }}
          />
        </div>
        <span className="gov-involvement-pct" style={{ color: pctColor }}>
          {Math.round(score)}%
        </span>
      </div>
    </div>
  );
}

/**
 * Human-involvement-policy-specific block: score bar + tier + gate checklist +
 * transition note + the `auto`-tier restrict-agents override. Rendered only when
 * `humanInvolvement` details are present.
 */
function HumanInvolvementDetailsBlock({
  details, fragmentKey, onRestrictAgents,
}: {
  details: HumanInvolvementSectionDetails;
  fragmentKey: string;
  onRestrictAgents?: (fragmentKey: string) => void;
}) {
  const cfg = TIER_CONFIG[details.agentTier];
  return (
    <>
      <InvolvementBar score={details.involvementScore} />
      <div className={`gov-agent-tier ${cfg.cssClass}`}>
        <span className="gov-agent-tier-icon">{cfg.icon}</span>
        <span>{cfg.label}</span>
      </div>
      {details.gates.length > 0 && (
        <ul className="gov-gate-list">
          {details.gates.map((gate, i) => (
            <li key={i} className="gov-gate-item">
              <span className={`gov-gate-dot ${gate.active ? "gov-gate-dot-active" : ""}`} />
              <span>{gate.label}</span>
            </li>
          ))}
        </ul>
      )}
      {details.tierTransitionNote && <div className="gov-decay-note">{details.tierTransitionNote}</div>}
      {details.agentTier === "auto" && onRestrictAgents && (
        <button className="gov-override-btn" onClick={() => onRestrictAgents(fragmentKey)}>
          Override: restrict agents
        </button>
      )}
    </>
  );
}

function AgentPermissionsBlock({
  canWrite, message, lastEditorNote, humanInvolvement, fragmentKey, onRestrictAgents,
}: {
  canWrite: boolean;
  message: string;
  lastEditorNote: string;
  humanInvolvement?: HumanInvolvementSectionDetails;
  fragmentKey: string;
  onRestrictAgents?: (fragmentKey: string) => void;
}) {
  return (
    <div className="gov-agent-permissions-block">
      <div className="gov-meta-label">Agent permissions</div>
      {/* Generic, policy-agnostic decision: allowed / blocked badge. */}
      <div
        className={`gov-agent-write-badge ${canWrite ? "gov-agent-write-allowed" : "gov-agent-write-blocked"}`}
        data-can-write={canWrite ? "true" : "false"}
      >
        <span className="gov-agent-write-icon">{canWrite ? "✓" : "✖"}</span>
        <span>{canWrite ? "Agents can write" : "Agents blocked"}</span>
      </div>
      {/* Backend prose is the primary explanation (Area M: never map a code). */}
      {message ? <div className="gov-agent-write-message">{message}</div> : null}
      {lastEditorNote ? <div className="gov-decay-note">{lastEditorNote}</div> : null}
      {humanInvolvement ? (
        <HumanInvolvementDetailsBlock
          details={humanInvolvement}
          fragmentKey={fragmentKey}
          onRestrictAgents={onRestrictAgents}
        />
      ) : null}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────

export function GovernanceLeftGutter({ sections, onRestrictAgents }: GovernanceLeftGutterProps) {
  const { hoveredFragmentKey, activeFragmentKey } = useSectionHover();
  return (
    <div className="gov-gutter gov-gutter-left">
      <div className="gov-gutter-header">Control &amp; agent policy</div>
      {sections.map((section, position) => {
        const isHighlighted =
          hoveredFragmentKey === section.fragmentKey ||
          activeFragmentKey === section.fragmentKey;
        return (
        <div
          key={section.fragmentKey}
          className="gov-section-control"
          style={isHighlighted ? {
            background: "var(--gov-paper)",
            marginRight: -50,
            paddingRight: 50,
            marginLeft: -10,
            paddingLeft: 10,
          } : undefined}
        >
          <div className="gov-section-number">
            &sect; {position + 1}
            {section.heading ? ` — ${section.heading}` : ""}
          </div>
          {section.inProgressProposal ? (
            <InProgressProposalBadge fact={section.inProgressProposal} />
          ) : null}
          <AgentPermissionsBlock
            canWrite={section.canWrite}
            message={section.message}
            lastEditorNote={section.lastEditorNote}
            humanInvolvement={section.humanInvolvement}
            fragmentKey={section.fragmentKey}
            onRestrictAgents={onRestrictAgents}
          />
        </div>
        );
      })}
    </div>
  );
}
