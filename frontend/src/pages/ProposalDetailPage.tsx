import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type { AnyProposal, ProposalDTO, EvaluatedSection } from "../types/shared.js";
import { headingPathToLabel } from "./document-page-utils";
import { stripLeadingSlashForRoute } from "../app/docsRouteUtils";

function involvementColor(score: number): string {
  if (score >= 0.8) return "#1e40af";
  if (score >= 0.5) return "#2563eb";
  if (score >= 0.3) return "#60a5fa";
  return "#94a3b8";
}

/** Reconstruct what the on-disk JSON file contains (status is NOT stored in the file). */
function reconstructFileJson(proposal: ProposalDTO): Record<string, unknown> {
  const file: Record<string, unknown> = {
    id: proposal.id,
    writer: proposal.writer,
    intent: proposal.intent,
    sections: proposal.sections,
    created_at: proposal.created_at,
  };
  if (proposal.status === "committed") {
    const committed = proposal as import("../types/shared.js").CommittedProposalDomain;
    file.committed_head = committed.committed_head;
    file.humanInvolvement_at_commit = committed.humanInvolvement_at_commit;
  }
  if (proposal.status === "withdrawn" && "withdrawal_reason" in proposal) {
    file.withdrawal_reason = (proposal as import("../types/shared.js").WithdrawnProposalDomain).withdrawal_reason;
  }
  return file;
}

const fieldCheckStyle: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "12px",
  padding: "4px 8px",
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

function FieldCheck({ label, present, expectedWhen }: { label: string; present: boolean; expectedWhen: string }) {
  return (
    <div style={fieldCheckStyle}>
      <span style={{ color: present ? "#3a9a5c" : "#8a8279", fontSize: "14px" }}>
        {present ? "\u2713" : "\u2717"}
      </span>
      <span style={{ color: present ? "#1a1610" : "#b8b2a8" }}>{label}</span>
      <span style={{ color: "#b8b2a8", fontSize: "10px", marginLeft: "auto" }}>{expectedWhen}</span>
    </div>
  );
}

function ProposalFileViewer({ proposal }: { proposal: ProposalDTO }) {
  const [expanded, setExpanded] = useState(false);

  const directoryPath = `proposals/${proposal.status}/${proposal.id}/meta.json`;
  const fileJson = reconstructFileJson(proposal);

  return (
    <div style={{
      marginTop: "1.5rem",
      border: "1px solid var(--color-footer-border)",
      borderRadius: "8px",
      overflow: "hidden",
      background: "#fff",
    }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "10px 14px",
          background: expanded ? "#faf8f5" : "#fff",
          border: "none",
          cursor: "pointer",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "12px",
          color: "#5c564c",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: "10px", transition: "transform 0.15s", transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>
          &#9654;
        </span>
        <span>On-Disk File Viewer</span>
        <span style={{ color: "#b8b2a8", marginLeft: "auto", fontSize: "11px" }}>{directoryPath}</span>
      </button>

      {expanded && (
        <div style={{ borderTop: "1px solid #f0ede8" }}>
          {/* Directory info */}
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--color-footer-border)" }}>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "#8a8279", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
              File Location
            </div>
            <div className="code-inline">
              <span style={{ color: "var(--color-text-muted)" }}>$KS_DATA_ROOT/</span>
              <span style={{ color: "var(--color-accent)", fontWeight: 600 }}>proposals/{proposal.status}/</span>
              <span>{proposal.id}.json</span>
            </div>
            <div style={{ fontSize: "11px", color: "#8a8279", marginTop: "6px" }}>
              Status is derived from the directory — it is <strong>not</strong> stored inside the JSON file.
              State transitions move the file between directories.
            </div>
          </div>

          {/* Field presence checks */}
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--color-footer-border)" }}>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "#8a8279", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
              Field Presence
            </div>
            <div style={{ background: "#f7f5f1", borderRadius: "5px", padding: "4px 0" }}>
              <FieldCheck label="status" present={false} expectedWhen="never stored in file" />
              <FieldCheck label="humanInvolvement_evaluation" present={false} expectedWhen="never stored — computed at read time" />
              <FieldCheck label="committed_head" present={proposal.status === "committed" && "committed_head" in proposal} expectedWhen="written at commit time only" />
              <FieldCheck label="humanInvolvement_at_commit" present={proposal.status === "committed" && "humanInvolvement_at_commit" in proposal} expectedWhen="written at commit time only" />
              <FieldCheck label="withdrawal_reason" present={proposal.status === "withdrawn" && "withdrawal_reason" in proposal} expectedWhen="written at withdrawal only" />
            </div>
          </div>

          {/* Raw JSON */}
          <div style={{ padding: "12px 14px" }}>
            <div style={{ fontSize: "11px", fontWeight: 600, color: "#8a8279", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
              Raw File Contents
            </div>
            <pre className="code-inline" style={{ overflow: "auto", maxHeight: "400px", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5 }}>
              {JSON.stringify(fileJson, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProposalDetailPage() {
  const { id } = useParams();
  const [proposal, setProposal] = useState<ProposalDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const evaluation = proposal && (proposal.status === "draft" || proposal.status === "committing")
    ? (proposal as import("../types/shared.js").DraftProposalDTO).humanInvolvement_evaluation
    : undefined;

  const loadProposal = useCallback(async () => {
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.getProposal(id);
      setProposal(response.proposal);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadProposal();
  }, [loadProposal]);

  const handleCommit = useCallback(async () => {
    if (!proposal) return;
    setActionBusy(true);
    setError(null);
    try {
      await apiClient.commitProposal(proposal.id);
      await loadProposal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [loadProposal, proposal]);

  const handleAcquireLocks = useCallback(async () => {
    if (!proposal) return;
    setActionBusy(true);
    setError(null);
    try {
      const resp = await apiClient.acquireLocks(proposal.id);
      if (!resp.acquired) {
        const sectionLabel = resp.section
          ? ` (${resp.section.heading_path.join(" > ")})`
          : "";
        setError(`Lock failed${sectionLabel}: ${resp.reason}`);
      }
      await loadProposal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [loadProposal, proposal]);

  const handleWithdraw = useCallback(async () => {
    if (!proposal) return;
    setActionBusy(true);
    setError(null);
    try {
      await apiClient.withdrawProposal(proposal.id, "Withdrawn from proposal detail.");
      await loadProposal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [loadProposal, proposal]);

  const affectedDocs = proposal
    ? Array.from(new Set(proposal.sections.map((s) => s.doc_path)))
    : [];

  return (
    <section>
      <SharedPageHeader title="Proposal Detail" backTo="/proposals" />
      <p>Proposal ID: {id ?? "(unknown)"}</p>
      {loading ? <p>Loading proposal...</p> : null}
      {error ? <p className="text-error">{error}</p> : null}
      {proposal ? (
        <>
          <p>Status: <strong>{proposal.status}</strong></p>
          <p>Writer: {proposal.writer.displayName} ({proposal.writer.type})</p>
          <p>Created: {new Date(proposal.created_at).toLocaleString()}</p>
          <p>Intent: {proposal.intent}</p>
          {proposal.status === "committed" ? <p>Committed HEAD: <code>{(proposal as import("../types/shared.js").CommittedProposalDomain).committed_head}</code></p> : null}
          {proposal.status === "withdrawn" && "withdrawal_reason" in proposal ? <p>Withdrawal reason: {(proposal as import("../types/shared.js").WithdrawnProposalDomain).withdrawal_reason}</p> : null}

          <h2>Sections ({proposal.sections.length})</h2>
          {proposal.sections.length === 0 ? <p>No sections.</p> : (
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.3rem" }}>Document</th>
                  <th style={{ textAlign: "left", padding: "0.3rem" }}>Section</th>
                  <th style={{ textAlign: "center", padding: "0.3rem" }}>Human Involvement</th>
                  <th style={{ textAlign: "left", padding: "0.3rem" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {proposal.sections.map((section, idx) => {
                  const evalSection = evaluation?.blocked_sections.find(
                    (s) => s.doc_path === section.doc_path && JSON.stringify(s.heading_path) === JSON.stringify(section.heading_path)
                  ) ?? evaluation?.passed_sections.find(
                    (s) => s.doc_path === section.doc_path && JSON.stringify(s.heading_path) === JSON.stringify(section.heading_path)
                  );
                  const score = evalSection?.humanInvolvement_score ?? 0;
                  const blocked = evalSection?.blocked ?? false;
                  return (
                    <tr key={`${section.doc_path}-${section.heading_path.join("/")}-${idx}`}>
                      <td style={{ padding: "0.3rem" }}>
                        <Link to={`/docs/${stripLeadingSlashForRoute(section.doc_path)}`}>{section.doc_path}</Link>
                      </td>
                      <td style={{ padding: "0.3rem" }}>{headingPathToLabel(section.heading_path)}</td>
                      <td style={{ padding: "0.3rem", textAlign: "center", color: involvementColor(score) }}>
                        {score.toFixed(2)}
                      </td>
                      <td style={{ padding: "0.3rem" }}>
                        {blocked ? (
                          <span style={{ color: "#1e40af" }}>Blocked</span>
                        ) : (
                          <span style={{ color: "#94a3b8" }}>Passed</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {evaluation ? (
            <>
              <h2>Human Involvement Evaluation</h2>
              <ul>
                <li>All sections accepted: {evaluation.all_sections_accepted ? "yes" : "no"}</li>
                <li>Aggregate impact: {evaluation.aggregate_impact.toFixed(2)} / {evaluation.aggregate_threshold.toFixed(2)}</li>
                <li>Blocked sections: {evaluation.blocked_sections.length}</li>
                <li>Passed sections: {evaluation.passed_sections.length}</li>
              </ul>
            </>
          ) : null}

          <h2>Affected Documents</h2>
          {affectedDocs.length === 0 ? <p>None</p> : (
            <ul>
              {affectedDocs.map((docPath) => (
                <li key={docPath}>
                  <Link to={`/docs/${stripLeadingSlashForRoute(docPath)}`}>{docPath}</Link>
                </li>
              ))}
            </ul>
          )}

          <ProposalFileViewer proposal={proposal} />

          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
            <button type="button" onClick={() => void loadProposal()} disabled={actionBusy || loading}>
              Refresh
            </button>
            {proposal.writer.type === "human" && proposal.status === "draft" ? (
              <button
                type="button"
                onClick={handleAcquireLocks}
                disabled={actionBusy || !proposal.sections.length}
              >
                Lock Sections
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleCommit}
              disabled={actionBusy || (proposal.writer.type === "human" ? proposal.status !== "inprogress" : proposal.status !== "draft")}
            >
              Publish
            </button>
            <button
              type="button"
              onClick={handleWithdraw}
              disabled={actionBusy || (proposal.status !== "draft" && proposal.status !== "inprogress")}
            >
              Withdraw
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
