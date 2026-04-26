/**
 * ProposalPanel — floating panel for human proposal creation and management.
 *
 * When no active proposal: shows a small "Create Proposal" button.
 * When active proposal: expands to show:
 *   - List of documents with section names
 *   - Required intent/description field
 *   - "Publish" button (commits the proposal)
 *   - "Cancel" button (withdraws the proposal)
 */

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../services/api-client";
import { sectionGlobalKey, type ProposalDTO } from "../types/shared.js";
import { headingPathToLabel } from "../pages/document-page-utils";

export interface ProposalPanelProps {
  /** Currently active proposal ID (if in proposal mode). */
  activeProposalId: string | null;
  /** Whether proposal mode is active. */
  proposalMode: boolean;
  /** Callback to enter proposal mode with a new proposal. */
  onEnterProposalMode: (proposalId: string) => void;
  /** Callback to exit proposal mode (after publish or cancel). */
  onExitProposalMode: () => void | Promise<void>;
  /** Called whenever fresh proposal state is loaded from the server. */
  onProposalLoaded?: (proposal: ProposalDTO | null) => void;
  /** Remove a selected section from the active proposal. */
  onRemoveProposalSection?: (docPath: string, headingPath: string[]) => void | Promise<void>;
  /** Increments when WS indicates selected-section conflicts may have changed. */
  proposalConflictInvalidationSeq?: number;
  /** Selected-section conflict reasons keyed by sectionGlobalKey(doc_path, heading_path). */
  proposalSectionConflicts?: Map<string, string>;
  /** Server proposal status mirrored from session controller. */
  activeProposalStatus?: ProposalDTO["status"] | null;
  /** Draft intent state owned by session controller. */
  proposalIntent?: string;
  /** Whether intent should be editable in this state. */
  canEditIntent?: boolean;
  /** Called when user edits draft intent. */
  onProposalIntentChange?: (nextIntent: string) => void;
}

export function ProposalPanel({
  activeProposalId,
  proposalMode,
  onEnterProposalMode,
  onExitProposalMode,
  onProposalLoaded,
  onRemoveProposalSection,
  proposalConflictInvalidationSeq = 0,
  proposalSectionConflicts,
  activeProposalStatus,
  proposalIntent,
  canEditIntent = false,
  onProposalIntentChange,
}: ProposalPanelProps) {
  const [proposal, setProposal] = useState<ProposalDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [acquiringLocks, setAcquiringLocks] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load active proposal details
  useEffect(() => {
    if (!activeProposalId) {
      setProposal(null);
      onProposalLoaded?.(null);
      return;
    }
    let cancelled = false;
    apiClient.getProposal(activeProposalId).then((resp) => {
      if (!cancelled) {
        setProposal(resp.proposal);
        onProposalLoaded?.(resp.proposal);
      }
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [activeProposalId, onProposalLoaded]);

  // Refresh proposal state when WS-invalidated conflict sources change.
  useEffect(() => {
    if (!activeProposalId || !proposalMode) return;
    let cancelled = false;
    apiClient.getProposal(activeProposalId).then((resp) => {
      if (cancelled) return;
      setProposal(resp.proposal);
      onProposalLoaded?.(resp.proposal);
    }).catch(() => { /* non-fatal refresh */ });
    return () => { cancelled = true; };
  }, [activeProposalId, onProposalLoaded, proposalConflictInvalidationSeq, proposalMode]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const existingDrafts = await apiClient.listMyProposals("draft");
      const mostRecentDraft = [...existingDrafts.proposals]
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      if (mostRecentDraft) {
        onEnterProposalMode(mostRecentDraft.id);
        return;
      }
      const resp = await apiClient.submitProposal({
        intent: "",
        sections: [],
      });
      onEnterProposalMode(resp.proposal_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [onEnterProposalMode]);

  const handleAcquireLocks = useCallback(async () => {
    if (!activeProposalId) return;
    setAcquiringLocks(true);
    setError(null);
    try {
      const resp = await apiClient.acquireLocks(activeProposalId);
      if (!resp.acquired) {
        const sectionLabel = resp.section
          ? ` (${resp.section.heading_path.join(" > ")})`
          : "";
        setError(`Lock failed${sectionLabel}: ${resp.reason}`);
      } else {
        // Refresh proposal to reflect new inprogress status
        const updated = await apiClient.getProposal(activeProposalId);
        setProposal(updated.proposal);
        onProposalLoaded?.(updated.proposal);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAcquiringLocks(false);
    }
  }, [activeProposalId, onProposalLoaded]);

  const handlePublish = useCallback(async () => {
    if (!activeProposalId) return;
    setPublishing(true);
    setError(null);
    try {
      await apiClient.commitProposal(activeProposalId);
      await onExitProposalMode();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(false);
    }
  }, [activeProposalId, onExitProposalMode]);

  const handleCancel = useCallback(async () => {
    if (!activeProposalId) return;
    setCancelling(true);
    setError(null);
    try {
      await apiClient.cancelProposal(activeProposalId, "User cancelled");
      await onExitProposalMode();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }, [activeProposalId, onExitProposalMode]);

  const proposalSections = proposal
    ? (proposal.sections as Array<{ doc_path: string; heading_path: string[]; blocked?: boolean }>)
    : [];
  const displayIntent = proposalIntent ?? proposal?.intent ?? "";

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
          onClick={() => void handleCreate()}
          disabled={creating}
          style={{
            padding: "0.5rem 0.9rem",
            fontSize: "0.82rem",
            cursor: creating ? "default" : "pointer",
            borderRadius: "999px",
            border: "1px solid #2563eb",
            background: "#2563eb",
            color: "#fff",
            boxShadow: "0 3px 10px rgba(37,99,235,0.25)",
          }}
        >
          {creating ? "Starting..." : "Start Manual Publish"}
        </button>
        {error ? (
          <p style={{ color: "#c0392b", fontSize: "0.75rem", margin: 0, maxWidth: "18rem", textAlign: "right" }}>
            {error}
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
                {onRemoveProposalSection && (proposal?.status === "draft" || activeProposalStatus === "draft") ? (
                  <button
                    type="button"
                    style={{ padding: "0.2rem 0.45rem", fontSize: "0.72rem", cursor: "pointer" }}
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
        {proposal?.status === "draft" ? (
          <button
            type="button"
            onClick={() => void handleAcquireLocks()}
            disabled={acquiringLocks || cancelling || !proposal?.sections.length || displayIntent.trim().length === 0}
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
            onClick={() => void handlePublish()}
            disabled={publishing || cancelling || proposal?.status !== "inprogress"}
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
            {publishing ? "Publishing..." : "Publish"}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={publishing || acquiringLocks || cancelling}
          style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", cursor: "pointer" }}
        >
          {cancelling ? "Cancelling..." : "Cancel"}
        </button>
      </div>

      {proposal?.status === "draft" && displayIntent.trim().length === 0 ? (
        <p style={{ color: "#92400e", fontSize: "0.75rem", margin: "0.45rem 0 0" }}>
          Intent is required before acquiring locks.
        </p>
      ) : null}

      {error ? <p style={{ color: "#c0392b", fontSize: "0.8rem", margin: "0.5rem 0 0" }}>{error}</p> : null}
    </div>
  );
}
