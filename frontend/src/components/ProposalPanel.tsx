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
import { apiClient, resolveWriterId } from "../services/api-client";
import type { AnyProposal } from "../types/shared.js";

export interface ProposalPanelProps {
  /** Currently active proposal ID (if in proposal mode). */
  activeProposalId: string | null;
  /** Whether proposal mode is active. */
  proposalMode: boolean;
  /** Callback to enter proposal mode with a new proposal. */
  onEnterProposalMode: (proposalId: string) => void;
  /** Callback to exit proposal mode (after publish or cancel). */
  onExitProposalMode: () => void;
}

export function ProposalPanel({
  activeProposalId,
  proposalMode,
  onEnterProposalMode,
  onExitProposalMode,
}: ProposalPanelProps) {
  const [intent, setIntent] = useState("");
  const [proposal, setProposal] = useState<AnyProposal | null>(null);
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load active proposal details
  useEffect(() => {
    if (!activeProposalId) {
      setProposal(null);
      return;
    }
    let cancelled = false;
    apiClient.getProposal(activeProposalId).then((resp) => {
      if (!cancelled) {
        setProposal(resp.proposal);
        setIntent(resp.proposal.intent);
      }
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [activeProposalId]);

  // Periodically refresh proposal to see updated sections
  useEffect(() => {
    if (!activeProposalId || !proposalMode) return;
    const timer = setInterval(() => {
      apiClient.getProposal(activeProposalId).then((resp) => {
        setProposal(resp.proposal);
      }).catch(() => { /* non-fatal poll */ });
    }, 5000);
    return () => clearInterval(timer);
  }, [activeProposalId, proposalMode]);

  const handleCreate = useCallback(async () => {
    if (!intent.trim()) {
      setError("Intent is required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const resp = await apiClient.submitProposal({
        intent: intent.trim(),
        sections: [],
      });
      onEnterProposalMode(resp.proposal_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [intent, onEnterProposalMode]);

  const handlePublish = useCallback(async () => {
    if (!activeProposalId) return;
    setPublishing(true);
    setError(null);
    try {
      await apiClient.commitProposal(activeProposalId);
      onExitProposalMode();
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
      onExitProposalMode();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }, [activeProposalId, onExitProposalMode]);

  // Group sections by doc_path for display
  const sectionsByDoc = new Map<string, string[]>();
  if (proposal) {
    for (const section of proposal.sections) {
      const existing = sectionsByDoc.get(section.doc_path) ?? [];
      existing.push(section.heading_path.join(" > ") || "(root)");
      sectionsByDoc.set(section.doc_path, existing);
    }
  }

  // ── Not in proposal mode: show create button ──
  if (!proposalMode) {
    return (
      <div style={{
        position: "fixed",
        top: "calc(var(--spacing-topbar-h) + 0.75rem)",
        right: "1.5rem",
        zIndex: 1000,
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: "0.5rem",
        padding: "0.75rem",
        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
        maxWidth: "20rem",
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <input
            type="text"
            placeholder="What do you intend to change?"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            style={{ padding: "0.4rem", fontSize: "0.85rem", border: "1px solid #cbd5e1", borderRadius: "0.25rem" }}
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !intent.trim()}
            style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", cursor: "pointer" }}
          >
            {creating ? "Creating..." : "Create Proposal"}
          </button>
          {error ? <p style={{ color: "#c0392b", fontSize: "0.8rem", margin: 0 }}>{error}</p> : null}
        </div>
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
        <div style={{ fontSize: "0.85rem", color: "#334155" }}>{proposal?.intent ?? intent}</div>
      </div>

      {/* Sections by document */}
      {sectionsByDoc.size > 0 ? (
        <div style={{ marginBottom: "0.5rem" }}>
          <label style={{ fontSize: "0.8rem", display: "block", marginBottom: "0.2rem" }}>Sections:</label>
          {[...sectionsByDoc.entries()].map(([docPath, sectionNames]) => (
            <div key={docPath} style={{ fontSize: "0.8rem", color: "#475569", marginBottom: "0.15rem" }}>
              <strong>{docPath}</strong>: {sectionNames.join(", ")}
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: "0.8rem", color: "#94a3b8", margin: "0.25rem 0" }}>
          No sections edited yet. Edit any section to add it to this proposal.
        </p>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
        <button
          type="button"
          onClick={() => void handlePublish()}
          disabled={publishing || cancelling || !proposal?.sections.length}
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
        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={publishing || cancelling}
          style={{ padding: "0.4rem 0.75rem", fontSize: "0.85rem", cursor: "pointer" }}
        >
          {cancelling ? "Cancelling..." : "Cancel"}
        </button>
      </div>

      {error ? <p style={{ color: "#c0392b", fontSize: "0.8rem", margin: "0.5rem 0 0" }}>{error}</p> : null}
    </div>
  );
}
