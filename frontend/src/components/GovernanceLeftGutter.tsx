/**
 * GovernanceLeftGutter — per-section control & agent policy column.
 *
 * Renders alongside the document body in governance mode. Each section
 * gets a single "Agent permissions" block showing:
 *   - Human involvement score (0-100%, bar)
 *   - Last-human-editor note
 *   - Agent permission tier (blocked / gated / auto)
 *   - Deterministic gate checklist
 *
 * "Dumb" component — receives all data via props, no internal fetching.
 * Styles in governance-gutters.css (all prefixed gov-).
 */

import { useSectionHover } from "../contexts/sectionHoverUtils";

// ─── Types ───────────────────────────────────────────────────────

export type AgentTier = "blocked" | "gated" | "auto";

export interface GateRule {
  label: string;
  active: boolean;
}

export interface GovernanceSectionControl {
  sectionIndex: number;
  heading: string;
  involvementScore: number;
  agentTier: AgentTier;
  lastEditorNote: string;
  gates: GateRule[];
  tierTransitionNote?: string;
}

export interface GovernanceLeftGutterProps {
  sections: GovernanceSectionControl[];
  onRestrictAgents?: (sectionIndex: number) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────

const TIER_CONFIG: Record<AgentTier, { cssClass: string; icon: string; label: string }> = {
  blocked: { cssClass: "gov-agent-tier-blocked", icon: "\u2716", label: "Agents blocked \u2014 human involvement high" },
  gated:   { cssClass: "gov-agent-tier-gated",   icon: "\u25C6", label: "Gated writes \u2014 deterministic checks" },
  auto:    { cssClass: "gov-agent-tier-auto",     icon: "\u2713", label: "Auto \u2014 low-risk reads & writes" },
};

// ─── Sub-components ──────────────────────────────────────────────

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

function AgentPermissionsBlock({
  tier, gates, tierTransitionNote, lastEditorNote, involvementScore, sectionIndex, onRestrictAgents,
}: {
  tier: AgentTier;
  gates: GateRule[];
  tierTransitionNote?: string;
  lastEditorNote: string;
  involvementScore: number;
  sectionIndex: number;
  onRestrictAgents?: (sectionIndex: number) => void;
}) {
  const cfg = TIER_CONFIG[tier];
  return (
    <div className="gov-agent-permissions-block">
      <div className="gov-meta-label">Agent permissions</div>
      <InvolvementBar score={involvementScore} />
      {lastEditorNote ? <div className="gov-decay-note">{lastEditorNote}</div> : null}
      <div className={`gov-agent-tier ${cfg.cssClass}`}>
        <span className="gov-agent-tier-icon">{cfg.icon}</span>
        <span>{cfg.label}</span>
      </div>
      {gates.length > 0 && (
        <ul className="gov-gate-list">
          {gates.map((gate, i) => (
            <li key={i} className="gov-gate-item">
              <span className={`gov-gate-dot ${gate.active ? "gov-gate-dot-active" : ""}`} />
              <span>{gate.label}</span>
            </li>
          ))}
        </ul>
      )}
      {tierTransitionNote && <div className="gov-decay-note">{tierTransitionNote}</div>}
      {tier === "auto" && onRestrictAgents && (
        <button className="gov-override-btn" onClick={() => onRestrictAgents(sectionIndex)}>
          Override: restrict agents
        </button>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────

export function GovernanceLeftGutter({ sections, onRestrictAgents }: GovernanceLeftGutterProps) {
  const { hoveredSection, activeSectionIndex } = useSectionHover();
  return (
    <div className="gov-gutter gov-gutter-left">
      <div className="gov-gutter-header">Control &amp; agent policy</div>
      {sections.map((section) => {
        const isHighlighted =
          hoveredSection === section.sectionIndex ||
          activeSectionIndex === section.sectionIndex;
        return (
        <div
          key={section.sectionIndex}
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
            &sect; {section.sectionIndex + 1}
            {section.heading ? ` \u2014 ${section.heading}` : ""}
          </div>
          <AgentPermissionsBlock
            tier={section.agentTier}
            gates={section.gates}
            tierTransitionNote={section.tierTransitionNote}
            lastEditorNote={section.lastEditorNote}
            involvementScore={section.involvementScore}
            sectionIndex={section.sectionIndex}
            onRestrictAgents={onRestrictAgents}
          />
        </div>
        );
      })}
    </div>
  );
}
