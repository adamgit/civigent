/**
 * GovernanceRightGutter — audit trail column.
 *
 * Renders chronological audit entries per section with actor, badge,
 * action description, justification, timestamp, and gate approval note.
 *
 * "Dumb" component — receives all data via props, no internal fetching.
 * Styles in governance-gutters.css (all prefixed gov-).
 */

// ─── Types ───────────────────────────────────────────────────────

export type AuditActorType = "human" | "agent";

export type GateApproval =
  | { kind: "auto" }
  | { kind: "auto-gated" }
  | { kind: "human-approved"; approver: string }
  | { kind: "none" };

export interface AuditEntry {
  id: string;
  actorName: string;
  actorType: AuditActorType;
  avatarColor: string;
  avatarLabel: string;
  action: string;
  reason?: string;
  timestamp: string;
  displayTime: string;
  gateApproval: GateApproval;
  isSignoff?: boolean;
}

export interface SectionAuditGroup {
  sectionIndex: number;
  entries: AuditEntry[];
}

export interface GovernanceRightGutterProps {
  sectionGroups: SectionAuditGroup[];
}

// ─── Sub-components ──────────────────────────────────────────────

function ActorBadge({ actorType }: { actorType: AuditActorType }) {
  const cssClass = actorType === "human" ? "gov-actor-badge-human" : "gov-actor-badge-agent";
  const label = actorType === "human" ? "Human" : "Agent";
  return <span className={`gov-actor-badge ${cssClass}`}>{label}</span>;
}

function GateNote({ approval }: { approval: GateApproval }) {
  switch (approval.kind) {
    case "auto":
      return <span className="gov-audit-gate-note"> {"\u00B7"} auto-approved</span>;
    case "auto-gated":
      return <span className="gov-audit-gate-note"> {"\u00B7"} auto-approved (gated write)</span>;
    case "human-approved":
      return <span className="gov-audit-gate-note-escalated"> {"\u00B7"} required approval {"\u2014"} {approval.approver} approved</span>;
    case "none":
      return null;
  }
}

function AuditEntryRow({ entry }: { entry: AuditEntry }) {
  return (
    <div className="gov-audit-entry">
      <div className="gov-audit-row">
        <div className="gov-audit-avatar" style={{ backgroundColor: entry.avatarColor }}>
          {entry.avatarLabel}
        </div>
        <div className="gov-audit-content">
          <div className="gov-audit-actor">
            <span>{entry.actorName}</span>
            {entry.isSignoff ? (
              <span className="gov-actor-badge gov-actor-badge-human">Sign-off</span>
            ) : (
              <ActorBadge actorType={entry.actorType} />
            )}
          </div>
          <div className="gov-audit-action">{entry.action}</div>
          {entry.reason && (
            <div className="gov-audit-reason">
              &ldquo;{entry.reason}&rdquo;
            </div>
          )}
          <div className="gov-audit-time">
            {entry.displayTime}
            <GateNote approval={entry.gateApproval} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────

export function GovernanceRightGutter({ sectionGroups }: GovernanceRightGutterProps) {
  return (
    <div className="gov-gutter gov-gutter-right">
      <div className="gov-gutter-header">Audit trail</div>
      {sectionGroups.map((group) => (
        <div key={group.sectionIndex}>
          {group.entries.length === 0 ? (
            <div className="gov-audit-empty">No changes recorded yet</div>
          ) : (
            group.entries.map((entry) => (
              <AuditEntryRow key={entry.id} entry={entry} />
            ))
          )}
        </div>
      ))}
    </div>
  );
}
