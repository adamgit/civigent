import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type {
  ProposalDTO,
  ProposalDefect,
  HumanInvolvementPolicyResult,
  HumanInvolvementTargetDetails,
} from "../types/shared.js";
import {
  proposalDeletedSectionFileDocPathForDisplay,
  proposalSectionDocPathForDisplay,
  proposalTargetDocPathForDisplay,
  proposalTargetKey,
  proposalTargetLabel,
} from "../types/shared.js";
import { headingPathToLabel } from "./document-page-utils";
import { stripLeadingSlashForRoute } from "../app/docsRouteUtils";
import { DocPath } from "../types/shared";

function DocumentLinkWhenDisplayPathIsLiveDocPath({ displayPath }: { displayPath: string }) {
  if (!DocPath.isDocPath(displayPath)) {
    return <>{displayPath}</>;
  }
  return <Link to={`/docs/${stripLeadingSlashForRoute(displayPath)}`}>{displayPath}</Link>;
}

function involvementColor(score: number): string {
  if (score >= 0.8) return "#1e40af";
  if (score >= 0.5) return "#2563eb";
  if (score >= 0.3) return "#60a5fa";
  return "#94a3b8";
}

/**
 * Prominent banner for a degraded proposal. `degraded` is a decoded domain field
 * (never written by healthy proposals). The raw defect token(s) are shown verbatim
 * as code — the frontend does NOT translate them into English, promise an autofix,
 * or otherwise duplicate backend semantics; the codes ARE the truth. The only prose
 * that varies is the lifecycle framing: a TERMINAL (committed/withdrawn) proposal is
 * a corrupt permanent record retained for audit, so it must not imply any future
 * commit/lock lifecycle; a non-terminal one is simply flagged as degraded.
 */
function DegradedBanner({ defects, terminal }: { defects: ProposalDefect[]; terminal: boolean }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: "1rem",
        border: "2px solid #b91c1c",
        borderRadius: "8px",
        background: "#fef2f2",
        padding: "12px 16px",
        color: "#7f1d1d",
      }}
    >
      <strong style={{ fontSize: "14px" }}>Degraded proposal</strong>
      <p style={{ margin: "4px 0 6px" }}>
        {terminal
          ? "This is a corrupt terminal proposal record. It is retained only for audit and " +
            "recovery investigation."
          : "This proposal was decoded with one or more defects and is flagged as degraded."}
      </p>
      <ul style={{ margin: 0 }}>
        {defects.map((defect) => (
          <li key={defect} style={{ marginBottom: "4px" }}>
            <code>{defect}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Decoded domain truth for the proposal: the authoritative `targets` claim set,
 * the identity-based `deleted_section_files` set, and the owning `proposalAdoptionId`.
 * These are decoded fields off the DTO — NOT a reconstruction of on-disk bytes.
 */
function ProposalTruthPanel({ proposal }: { proposal: ProposalDTO }) {
  const targets = proposal.targets;
  const deletedSectionFiles = proposal.deleted_section_files ?? [];

  return (
    <div style={{ marginTop: "1.5rem" }}>
      <h2>Targets ({targets.length})</h2>
      <p>The authoritative lock / audit / policy claim set for this proposal.</p>
      {targets.length === 0 ? (
        <p>No targets.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "0.3rem" }}>Kind</th>
              <th style={{ textAlign: "left", padding: "0.3rem" }}>Document</th>
              <th style={{ textAlign: "left", padding: "0.3rem" }}>Target</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((target, idx) => (
              <tr key={`${proposalTargetKey(target)}-${idx}`}>
                <td style={{ padding: "0.3rem" }}>{target.kind}</td>
                <td style={{ padding: "0.3rem" }}>
                  <DocumentLinkWhenDisplayPathIsLiveDocPath displayPath={proposalTargetDocPathForDisplay(target)} />
                </td>
                <td style={{ padding: "0.3rem" }}>{proposalTargetLabel(target)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deletedSectionFiles.length > 0 ? (
        <>
          <h2>Deleted Section Files ({deletedSectionFiles.length})</h2>
          <p>Canonical section-file ids this proposal has deleted (identity-based delete detection).</p>
          <ul>
            {deletedSectionFiles.map((ref, idx) => (
              <li key={`${proposalDeletedSectionFileDocPathForDisplay(ref)}-${ref.section_file}-${idx}`}>
                <code>{ref.section_file}</code> in{" "}
                <DocumentLinkWhenDisplayPathIsLiveDocPath displayPath={proposalDeletedSectionFileDocPathForDisplay(ref)} />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {proposal.proposalAdoptionId ? (
        <p>Proposal adoption ID: <code>{proposal.proposalAdoptionId}</code></p>
      ) : null}
    </div>
  );
}

export function ProposalDetailPage() {
  const { id } = useParams();
  const [proposal, setProposal] = useState<ProposalDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const agentWritePolicy: HumanInvolvementPolicyResult | undefined =
    proposal && (proposal.status === "draft" || proposal.status === "committing")
      ? (proposal as import("../types/shared.js").DraftProposalDTO).agentWritePolicy
      : undefined;
  const lockEvaluation = proposal && (proposal.status === "draft" || proposal.status === "committing")
    ? (proposal as import("../types/shared.js").DraftProposalDTO).lockEvaluation
    : undefined;
  // Human-involvement compatibility policy is "selected" iff any target surfaces
  // a numeric score detail; only then do score columns/cells render.
  const hasHumanInvolvementScores = !!agentWritePolicy?.targets.some(
    (t) => typeof t.details?.score === "number",
  );

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
        // Area M: render backend prose; never map a code/enum.
        setError(resp.message);
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

  // Affected documents derive from the authoritative `targets` claim set (not
  // `sections`), so document-level targets with no sections are still surfaced.
  const affectedDocs = proposal
    ? Array.from(new Set(proposal.targets.map((t) => proposalTargetDocPathForDisplay(t))))
    : [];

  return (
    <section>
      <SharedPageHeader title="Proposal Detail" backTo="/proposals" />
      <p>Proposal ID: {id ?? "(unknown)"}</p>
      {loading ? <p>Loading proposal...</p> : null}
      {error ? <p className="text-error">{error}</p> : null}
      {proposal ? (
        <>
          {proposal.degraded && proposal.degraded.length > 0 ? (
            <DegradedBanner
              defects={proposal.degraded}
              terminal={proposal.status === "committed" || proposal.status === "withdrawn"}
            />
          ) : null}
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
                  {hasHumanInvolvementScores ? (
                    <th style={{ textAlign: "center", padding: "0.3rem" }}>Human Involvement</th>
                  ) : null}
                  <th style={{ textAlign: "left", padding: "0.3rem" }}>Agent writes</th>
                  <th style={{ textAlign: "left", padding: "0.3rem" }}>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {proposal.sections.map((section, idx) => {
                  const sectionDocPath = proposalSectionDocPathForDisplay(section);
                  const target = agentWritePolicy?.targets.find(
                    (t) => t.target.kind === "section"
                      && t.target.doc_path === sectionDocPath
                      && JSON.stringify(t.target.heading_path) === JSON.stringify(section.heading_path)
                  );
                  const details: HumanInvolvementTargetDetails | undefined = target?.details;
                  const score = details?.score;
                  // canWrite drives styling/branching; prose `message` is the explanation (Area M).
                  const canWrite = target ? target.canWrite : true;
                  return (
                    <tr key={`${sectionDocPath}-${section.heading_path.join("/")}-${idx}`}>
                      <td style={{ padding: "0.3rem" }}>
                        <DocumentLinkWhenDisplayPathIsLiveDocPath displayPath={sectionDocPath} />
                      </td>
                      <td style={{ padding: "0.3rem" }}>{headingPathToLabel(section.heading_path)}</td>
                      {hasHumanInvolvementScores ? (
                        <td style={{ padding: "0.3rem", textAlign: "center", color: typeof score === "number" ? involvementColor(score) : undefined }}>
                          {typeof score === "number" ? score.toFixed(2) : "—"}
                        </td>
                      ) : null}
                      <td style={{ padding: "0.3rem" }}>
                        {canWrite ? (
                          <span style={{ color: "#3a9a5c" }}>Allowed</span>
                        ) : (
                          <span style={{ color: "#b91c1c" }}>Blocked</span>
                        )}
                      </td>
                      <td style={{ padding: "0.3rem", color: "#5c564c" }}>
                        {target?.message ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {agentWritePolicy ? (
            <>
              <h2>Agent Write Policy</h2>
              {/* Backend prose is the primary explanation (Area M). */}
              <p>{agentWritePolicy.message}</p>
              <ul>
                <li>Agents can write: {agentWritePolicy.canWrite ? "yes" : "no"}</li>
                {hasHumanInvolvementScores ? (
                  <li>
                    Aggregate impact: {agentWritePolicy.details.aggregateImpact.toFixed(2)} / {agentWritePolicy.details.aggregateThreshold.toFixed(2)}
                  </li>
                ) : null}
                <li>Blocked sections: {agentWritePolicy.targets.filter((t) => !t.canWrite).length}</li>
                <li>Allowed sections: {agentWritePolicy.targets.filter((t) => t.canWrite).length}</li>
              </ul>
            </>
          ) : null}

          {lockEvaluation && lockEvaluation.conflicts.length > 0 ? (
            <>
              <h2>Lock Conflicts</h2>
              <p>{lockEvaluation.message}</p>
              <ul>
                {lockEvaluation.conflicts.map((conflict, i) => (
                  <li key={`${proposalTargetKey(conflict.target)}-${i}`}>
                    {proposalTargetLabel(conflict.target)}: {conflict.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h2>Affected Documents</h2>
          {affectedDocs.length === 0 ? <p>None</p> : (
            <ul>
              {affectedDocs.map((docPath) => (
                <li key={docPath}>
                  <DocumentLinkWhenDisplayPathIsLiveDocPath displayPath={docPath} />
                </li>
              ))}
            </ul>
          )}

          <ProposalTruthPanel proposal={proposal} />

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
