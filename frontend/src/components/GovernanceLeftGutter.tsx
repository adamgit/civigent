/**
 * GovernanceLeftGutter — per-section control & agent policy column.
 *
 * Renders alongside the document body in governance mode. Each section
 * gets a control block showing:
 *   - Human involvement score (0-100%, decaying bar)
 *   - Agent permission tier (blocked / gated / auto)
 *   - Deterministic gate checklist
 *   - Sign-off summary
 *
 * "Dumb" component — receives all data via props, no internal fetching.
 * Styles in governance-gutters.css (all prefixed gov-).
 */

// ─── Types ───────────────────────────────────────────────────────

export type AgentTier = "blocked" | "gated" | "auto";

export interface GateRule {
  label: string;
  active: boolean;
}

export interface SignoffEntry {
  name: string;
  role: string;
  signed: boolean;
  signedAt?: string;
}

export interface GovernanceSectionControl {
  sectionIndex: number;
  heading: string;
  involvementScore: number;
  agentTier: AgentTier;
  decayNote: string;
  gates: GateRule[];
  tierTransitionNote?: string;
  signoffs: SignoffEntry[];
  status: "signed" | "pending" | "draft";
}

export interface GovernanceLeftGutterProps {
  sections: GovernanceSectionControl[];
  onRestrictAgents?: (sectionIndex: number) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────

function involvementColorClass(score: number): string {
  if (score >= 70) return "high";
  if (score >= 30) return "med";
  return "low";
}

const TIER_CONFIG: Record<AgentTier, { cssClass: string; icon: string; label: string }> = {
  blocked: { cssClass: "gov-agent-tier-blocked", icon: "\u2716", label: "Agents blocked \u2014 human involvement high" },
  gated:   { cssClass: "gov-agent-tier-gated",   icon: "\u25C6", label: "Gated writes \u2014 deterministic checks" },
  auto:    { cssClass: "gov-agent-tier-auto",     icon: "\u2713", label: "Auto \u2014 low-risk reads & writes" },
};

const STATUS_CSS: Record<string, string> = {
  signed: "gov-status-signed",
  pending: "gov-status-pending",
  draft: "gov-status-draft",
};

function statusLabel(status: string, signoffs: SignoffEntry[]): string {
  const done = signoffs.filter((s) => s.signed).length;
  const total = signoffs.length;
  if (status === "signed") return `\u2713 ${done}/${total} signed`;
  if (status === "pending" && total > 0) {
    const awaiting = signoffs.filter((s) => !s.signed).map((s) => s.role).join(", ");
    return `${done}/${total} \u2014 awaiting ${awaiting}`;
  }
  if (status === "draft") return "Draft";
  return status;
}

// ─── Sub-components ──────────────────────────────────────────────

function InvolvementBar({ score }: { score: number }) {
  const band = involvementColorClass(score);
  return (
    <div className="gov-involvement">
      <div className="gov-meta-label">Human involvement</div>
      <div className="gov-involvement-bar-row">
        <div className="gov-involvement-bar-outer">
          <div
            className={`gov-involvement-bar-inner gov-involvement-${band}`}
            style={{ width: `${score}%` }}
          />
        </div>
        <span className={`gov-involvement-pct gov-involvement-pct-${band}`}>
          {Math.round(score)}%
        </span>
      </div>
    </div>
  );
}

function AgentTierBadge({
  tier, gates, tierTransitionNote, sectionIndex, onRestrictAgents,
}: {
  tier: AgentTier;
  gates: GateRule[];
  tierTransitionNote?: string;
  sectionIndex: number;
  onRestrictAgents?: (sectionIndex: number) => void;
}) {
  const cfg = TIER_CONFIG[tier];
  return (
    <div>
      <div className="gov-meta-label">Agent permissions</div>
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

function SignoffSummary({ signoffs, status }: { signoffs: SignoffEntry[]; status: string }) {
  if (signoffs.length === 0 && status === "draft") {
    return (
      <div className="gov-signoff-summary">
        <div className="gov-meta-label">Sign-off</div>
        <span className={`gov-status-pill ${STATUS_CSS[status]}`}>
          {statusLabel(status, signoffs)}
        </span>
      </div>
    );
  }
  return (
    <div className="gov-signoff-summary">
      <div className="gov-meta-label">Sign-off</div>
      {signoffs.length > 0 && (
        <div className="gov-signoff-block">
          {signoffs.map((entry, i) => (
            <div key={i} className="gov-signoff-row">
              <span className={`gov-signoff-check ${entry.signed ? "gov-signoff-check-done" : "gov-signoff-check-pending"}`}>
                {entry.signed ? "\u2713" : "\u2014"}
              </span>
              <span style={{ color: entry.signed ? "var(--gov-signed)" : "var(--gov-ink-tertiary)" }}>
                {entry.role} {"\u2014"} {entry.signed ? entry.name : "awaiting"}
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 4 }}>
        <span className={`gov-status-pill ${STATUS_CSS[status]}`}>
          {statusLabel(status, signoffs)}
        </span>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────

export function GovernanceLeftGutter({ sections, onRestrictAgents }: GovernanceLeftGutterProps) {
  return (
    <div className="gov-gutter gov-gutter-left">
      <div className="gov-gutter-header">Control &amp; agent policy</div>
      {sections.map((section) => (
        <div key={section.sectionIndex} className="gov-section-control">
          <div className="gov-section-number">
            &sect; {section.sectionIndex + 1}
            {section.heading ? ` \u2014 ${section.heading}` : ""}
          </div>
          <InvolvementBar score={section.involvementScore} />
          <div className="gov-decay-note">{section.decayNote}</div>
          <div style={{ marginTop: 8 }}>
            <AgentTierBadge
              tier={section.agentTier}
              gates={section.gates}
              tierTransitionNote={section.tierTransitionNote}
              sectionIndex={section.sectionIndex}
              onRestrictAgents={onRestrictAgents}
            />
          </div>
          <SignoffSummary signoffs={section.signoffs} status={section.status} />
        </div>
      ))}
    </div>
  );
}
