import { sectionGlobalKey, type ProposalDTO } from "../types/shared.js";
import { headingPathToLabel } from "../pages/document-page-utils";

export interface ProposalPanelProps {
  /** Whether proposal mode is active. */
  proposalMode: boolean;
  /** Backend-backed active proposal snapshot. */
  activeProposal: ProposalDTO | null;
  /** Action states owned by session controller. */
  creatingProposal: boolean;
  acquiringLocks: boolean;
  publishingProposal: boolean;
  cancellingProposal: boolean;
  proposalScopeMutationInFlight: boolean;
  panelError: string | null;
  /** Start a new manual publish flow. */
  onStartManualPublish: () => void | Promise<void>;
  /** Acquire locks on current draft proposal. */
  onAcquireLocks: () => void | Promise<void>;
  /** Commit active inprogress proposal. */
  onPublish: () => void | Promise<void>;
  /** Cancel active proposal and exit proposal mode. */
  onCancel: () => void | Promise<void>;
  /** Remove a selected section from the active proposal. */
  onRemoveProposalSection: (docPath: string, headingPath: string[]) => void | Promise<void>;
  /** Selected-section conflict reasons keyed by sectionGlobalKey(doc_path, heading_path). */
  proposalSectionConflicts: Map<string, string>;
  /** Intent draft text owned by session controller. */
  proposalIntent: string;
  /** Whether intent should be editable in this state. */
  canEditIntent: boolean;
  /** Called when user edits draft intent. */
  onProposalIntentChange?: (nextIntent: string) => void;
}

export function ProposalPanel({
  proposalMode,
  activeProposal,
  creatingProposal,
  acquiringLocks,
  publishingProposal,
  cancellingProposal,
  proposalScopeMutationInFlight,
  panelError,
  onStartManualPublish,
  onAcquireLocks,
  onPublish,
  onCancel,
  onRemoveProposalSection,
  proposalSectionConflicts,
  proposalIntent,
  canEditIntent,
  onProposalIntentChange,
}: ProposalPanelProps) {
  const proposalSections = activeProposal
    ? (activeProposal.sections as Array<{ doc_path: string; heading_path: string[]; blocked?: boolean }>)
    : [];
  const displayIntent = proposalIntent;
  const proposalStatus = activeProposal?.status ?? null;

  // ── Not in proposal mode: show create button ──
  if (!proposalMode) {
    return (
      <div style={{
        position: "fixed",
        bottom: "1.25rem",
        right: "1.5rem",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: "0.4rem",
      }}>
        <button
          type="button"
          onClick={() => void onStartManualPublish()}
          disabled={creatingProposal}
          style={{
            padding: "0.5rem 0.9rem",
            fontSize: "0.82rem",
            cursor: creatingProposal ? "default" : "pointer",
            borderRadius: "999px",
            border: "1px solid #2563eb",
            background: "#2563eb",
            color: "#fff",
            boxShadow: "0 3px 10px rgba(37,99,235,0.25)",
          }}
        >
          {creatingProposal ? "Starting..." : "Start Manual Publish"}
        </button>
        {panelError ? (
          <p style={{ color: "#c0392b", fontSize: "0.75rem", margin: 0, maxWidth: "18rem", textAlign: "right" }}>
            {panelError}
          </p>
        ) : null}
      </div>
    );
  }

  // ── In proposal mode: show expanded panel ──
  return (
    <div style={{
      position: "fixed",
      top: "calc(var(--spacing-topbar-h) + 0.75rem)",
      right: "1.5rem",
      zIndex: 1000,
      background: "#fff",
      border: "2px solid #3b82f6",
      borderRadius: "0.5rem",
      padding: "1rem",
      boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
      maxWidth: "24rem",
      minWidth: "18rem",
      maxHeight: "calc(100vh - var(--spacing-topbar-h) - 3rem)",
      overflowY: "auto",
    }}>
      <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.95rem" }}>Active Proposal</h3>

      {/* Intent */}
      <div style={{ marginBottom: "0.5rem" }}>
        <label style={{ fontSize: "0.8rem", display: "block", marginBottom: "0.2rem" }}>Intent:</label>
        {canEditIntent && onProposalIntentChange ? (
          <input
            type="text"
            value={displayIntent}
            onChange={(event) => onProposalIntentChange(event.target.value)}
            placeholder="Describe your intended change"
            style={{ width: "100%", padding: "0.4rem", fontSize: "0.85rem", border: "1px solid #cbd5e1", borderRadius: "0.25rem" }}
          />
        ) : (
          <div style={{ fontSize: "0.85rem", color: "#334155" }}>{displayIntent}</div>
        )}
      </div>

      {/* Sections by document */}
      {proposalSections.length > 0 ? (
        <div style={{ marginBottom: "0.5rem" }}>
          <label style={{ fontSize: "0.8rem", display: "block", marginBottom: "0.2rem" }}>Sections:</label>
          {proposalSections.map((section) => {
            const sectionLabel = headingPathToLabel(section.heading_path);
            const sectionKey = sectionGlobalKey(section.doc_path, section.heading_path);
            const reason = proposalSectionConflicts?.get(sectionKey);
            const unacquirable = typeof reason === "string" && reason.length > 0;
            return (
              <div
                key={`${section.doc_path}::${section.heading_path.join(">>")}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                  fontSize: "0.8rem",
                  color: "#475569",
                  marginBottom: "0.2rem",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    <strong>{section.doc_path}</strong>: {sectionLabel}
                  </div>
                  {unacquirable ? (
                    <div style={{ color: "#b91c1c", fontSize: "0.72rem" }}>
                      error/unacquirable: {reason}
                    </div>
                  ) : null}
                </div>
                {proposalStatus === "draft" ? (
                  <button
                    type="button"
                    disabled={proposalScopeMutationInFlight}
                    style={{ padding: "0.2rem 0.45rem", fontSize: "0.72rem", cursor: proposalScopeMutationInFlight ? "default" : "pointer" }}
                    onClick={() => void onRemoveProposalSection(section.doc_path, section.heading_path)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p style={{ fontSize: "0.8rem", color: "#94a3b8", margin: "0.25rem 0" }}>
          No sections selected yet. Add sections from the document as you scroll.
        </p>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
        {proposalStatus === "draft" ? (
          <button
            type="button"
            onClick={() => void onAcquireLocks()}
            disabled={
              acquiringLocks
              || cancellingProposal
              || proposalScopeMutationInFlight
              || proposalSections.length === 0
              || displayIntent.trim().length === 0
            }
            style={{
              padding: "0.4rem 0.75rem",
              fontSize: "0.85rem",
              cursor: "pointer",
              background: "#f59e0b",
              color: "#fff",
              border: "none",
              borderRadius: "0.25rem",
            }}
          >
            {acquiringLocks ? "Locking..." : "Lock Sections"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void onPublish()}
            disabled={publishingProposal || cancellingProposal || proposalStatus !== "inprogress"}
            style={{
              padding: "0.4rem 0.75rem",
              fontSize: "0.85rem",
              cursor: "pointer",
              background: "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: "0.25rem",
            }}
          >
            {publishingProposal ? "Publishing..." : "Publish"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void onCancel()}
          disabled={publishingProposal || acquiringLocks || cancellingProposal}
          style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", cursor: "pointer" }}
        >
          {cancellingProposal ? "Cancelling..." : "Cancel"}
        </button>
      </div>

      {proposalStatus === "draft" && displayIntent.trim().length === 0 ? (
        <p style={{ color: "#92400e", fontSize: "0.75rem", margin: "0.45rem 0 0" }}>
          Intent is required before acquiring locks.
        </p>
      ) : null}

      {panelError ? <p style={{ color: "#c0392b", fontSize: "0.8rem", margin: "0.5rem 0 0" }}>{panelError}</p> : null}
    </div>
  );
}
