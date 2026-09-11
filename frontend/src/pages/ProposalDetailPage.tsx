import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ContentPanel } from "../components/ContentPanel";
import { StatusPill } from "../components/StatusPill";
import { WriterIdentity } from "../components/WriterIdentity";
import { apiClient } from "../services/api-client";
import type {
  ProposalDTO,
  ProposalDefect,
  HumanInvolvementPolicyResult,
  HumanInvolvementTargetDetails,
  ReadAdminProposalResponse,
} from "../types/shared.js";
import {
  proposalDeletedSectionFileDocPathForDisplay,
  proposalSectionDocPathForDisplay,
  proposalTargetDocPathForDisplay,
  proposalTargetKey,
  proposalTargetLabel,
} from "../types/shared.js";
import { headingPathToLabel } from "./document-page-utils";
import { docHref } from "../app/docs-location";
import { DocPath } from "../types/shared";

function DocumentLinkWhenDisplayPathIsLiveDocPath({ displayPath }: { displayPath: string }) {
  if (!DocPath.isDocPath(displayPath)) {
    return <span className="font-mono text-[12px] text-text-primary">{displayPath}</span>;
  }
  return (
    <Link to={docHref(displayPath)} className="font-mono text-[12px] text-accent hover:underline">
      {displayPath}
    </Link>
  );
}

function involvementColor(score: number): string {
  if (score >= 0.8) return "#1e40af";
  if (score >= 0.5) return "#2563eb";
  if (score >= 0.3) return "#60a5fa";
  return "#94a3b8";
}

function statusPillVariant(status: string): "green" | "yellow" | "red" | "muted" {
  switch (status) {
    case "draft": case "inprogress": case "committing": return "yellow";
    case "committed": return "green";
    case "withdrawn": return "red";
    default: return "muted";
  }
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
      className="mb-4 rounded-lg border-2 border-status-red bg-status-red-light px-4 py-3 text-status-red"
    >
      <strong className="text-[14px]">Degraded proposal</strong>
      <p className="my-1 text-[13px]">
        {terminal
          ? "This is a corrupt terminal proposal record. It is retained only for audit and " +
            "recovery investigation."
          : "This proposal was decoded with one or more defects and is flagged as degraded."}
      </p>
      <ul className="m-0">
        {defects.map((defect) => (
          <li key={defect} className="mb-1">
            <code className="font-mono text-[12px]">{defect}</code>
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
    <ContentPanel>
      <ContentPanel.Header>
        <div>
          <ContentPanel.Title>Targets ({targets.length})</ContentPanel.Title>
          <ContentPanel.Subtitle>
            The authoritative lock / audit / policy claim set for this proposal.
          </ContentPanel.Subtitle>
        </div>
      </ContentPanel.Header>
      <ContentPanel.Body className="p-0">
        {targets.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-text-muted m-0">No targets.</p>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-section-hover">
                <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Kind</th>
                <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Document</th>
                <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Target</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target, idx) => (
                <tr key={`${proposalTargetKey(target)}-${idx}`} className="border-t border-footer-border">
                  <td className="px-4 py-2 text-text-primary">{target.kind}</td>
                  <td className="px-4 py-2">
                    <DocumentLinkWhenDisplayPathIsLiveDocPath displayPath={proposalTargetDocPathForDisplay(target)} />
                  </td>
                  <td className="px-4 py-2 text-text-secondary">{proposalTargetLabel(target)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {deletedSectionFiles.length > 0 ? (
          <div className="px-4 py-3 border-t border-footer-border">
            <h2 className="m-0 text-[13px] font-semibold text-text-primary">
              Deleted Section Files ({deletedSectionFiles.length})
            </h2>
            <p className="mt-1 mb-2 text-[12px] text-text-muted">
              Canonical section-file ids this proposal has deleted (identity-based delete detection).
            </p>
            <ul className="m-0 pl-5 text-[13px] text-text-primary">
              {deletedSectionFiles.map((ref, idx) => (
                <li key={`${proposalDeletedSectionFileDocPathForDisplay(ref)}-${ref.section_file}-${idx}`}>
                  <code className="font-mono text-[12px]">{ref.section_file}</code> in{" "}
                  <DocumentLinkWhenDisplayPathIsLiveDocPath displayPath={proposalDeletedSectionFileDocPathForDisplay(ref)} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {proposal.proposalAdoptionId ? (
          <p className="px-4 py-3 border-t border-footer-border text-[13px] text-text-secondary m-0">
            Proposal adoption ID: <code className="font-mono text-[12px] text-text-primary">{proposal.proposalAdoptionId}</code>
          </p>
        ) : null}
      </ContentPanel.Body>
    </ContentPanel>
  );
}

export function ProposalDetailPage() {
  const { id } = useParams();
  const [proposal, setProposal] = useState<ProposalDTO | null>(null);
  const [rawFallback, setRawFallback] = useState<
    Extract<ReadAdminProposalResponse, { mode: "raw-fallback" }> | null
  >(null);
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
    setRawFallback(null);
    try {
      const response = await apiClient.getAdminProposal(id);
      if (response.mode === "full") {
        setProposal(response.proposal);
      } else {
        setProposal(null);
        setRawFallback(response);
      }
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

  const handleRawForceCancel = useCallback(async () => {
    if (!rawFallback) return;
    if (!window.confirm(`Force cancel proposal ${rawFallback.proposal_id}? This cannot be undone.`)) return;
    setActionBusy(true);
    setError(null);
    try {
      await apiClient.forceCancelProposal(
        rawFallback.proposal_id,
        "Force-cancelled from the admin raw proposal fallback.",
      );
      await loadProposal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [loadProposal, rawFallback]);

  // Affected documents derive from the authoritative `targets` claim set (not
  // `sections`), so document-level targets with no sections are still surfaced.
  const affectedDocs = proposal
    ? Array.from(new Set(proposal.targets.map((t) => proposalTargetDocPathForDisplay(t))))
    : [];

  return (
    <div className="flex flex-col">
      <SharedPageHeader title="Proposal Detail" backTo="/admin/proposals" />
      <div className="p-4 font-ui">
        <p className="text-[12px] text-text-muted mb-4">
          Proposal ID: <code className="font-mono text-text-primary">{id ?? "(unknown)"}</code>
        </p>
        {loading ? <p className="text-xs text-text-muted">Loading proposal...</p> : null}
        {error ? <p className="text-error">{error}</p> : null}
        {rawFallback ? (
          <div
            role="alert"
            className="mb-4 overflow-hidden rounded-lg border-2 border-status-red bg-status-red-light"
          >
            <div className="bg-status-red px-4 py-3 text-canvas-bg">
              <div className="text-lg font-bold uppercase tracking-wide">
                Raw diagnostic fallback
              </div>
              <p className="mt-1 mb-0 text-sm leading-5">
                The normal proposal view crashed while interpreting this proposal. This is a
                known, handled fallback: no proposal content was rendered or silently omitted.
              </p>
            </div>

            <div className="space-y-4 p-4">
              <section>
                <h2 className="m-0 text-sm font-bold text-status-red">Handled read failure</h2>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-status-red/30 bg-canvas-bg p-3 text-xs text-text-primary">
                  {rawFallback.read_error}
                </pre>
              </section>

              {rawFallback.raw_read_error ? (
                <section>
                  <h2 className="m-0 text-sm font-bold text-status-red">
                    Raw metadata could not be read
                  </h2>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-status-red/30 bg-canvas-bg p-3 text-xs text-text-primary">
                    {rawFallback.raw_read_error}
                  </pre>
                </section>
              ) : null}

              <section>
                <h2 className="m-0 text-sm font-bold text-text-primary">Uninterpreted metadata</h2>
                <p className="my-1 text-xs text-text-secondary">
                  Directory status: <strong>{rawFallback.status ?? "unknown"}</strong>. The text
                  below is the stored <code className="font-mono">meta.json</code> exactly as read from disk.
                </p>
                <pre className="code-block-dark mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap">
                  {rawFallback.raw_meta ?? "Raw metadata is unavailable."}
                </pre>
              </section>

              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary disabled:opacity-60"
                  onClick={() => void loadProposal()}
                  disabled={actionBusy || loading}
                >
                  Retry normal view
                </button>
                {(rawFallback.status === "draft"
                  || rawFallback.status === "pending"
                  || rawFallback.status === "inprogress") ? (
                  <button
                    type="button"
                    onClick={() => void handleRawForceCancel()}
                    disabled={actionBusy}
                    className="btn-danger disabled:opacity-60"
                  >
                    {actionBusy ? "Force cancelling…" : "Force cancel proposal"}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {proposal ? (
          <>
            {proposal.degraded && proposal.degraded.length > 0 ? (
              <DegradedBanner
                defects={proposal.degraded}
                terminal={proposal.status === "committed" || proposal.status === "withdrawn"}
              />
            ) : null}

            <ContentPanel>
              <ContentPanel.Header>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill variant={statusPillVariant(proposal.status)} showDot>
                    {proposal.status}
                  </StatusPill>
                  <WriterIdentity name={proposal.writer.displayName} kind={proposal.writer.type} />
                </div>
              </ContentPanel.Header>
              <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border">
                <span className="text-[12px] font-medium text-text-muted w-40 shrink-0">Created</span>
                <span className="text-[13px] text-text-primary">{new Date(proposal.created_at).toLocaleString()}</span>
              </div>
              <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border">
                <span className="text-[12px] font-medium text-text-muted w-40 shrink-0">Intent</span>
                <span className="text-[13px] text-text-primary italic">{proposal.intent}</span>
              </div>
              {proposal.status === "committed" ? (
                <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border">
                  <span className="text-[12px] font-medium text-text-muted w-40 shrink-0">Committed HEAD</span>
                  <code className="text-[12px] font-mono text-text-primary">
                    {(proposal as import("../types/shared.js").CommittedProposalDomain).committed_head}
                  </code>
                </div>
              ) : null}
              {proposal.status === "withdrawn" && "withdrawal_reason" in proposal ? (
                <div className="flex items-baseline gap-4 px-4 py-2">
                  <span className="text-[12px] font-medium text-text-muted w-40 shrink-0">Withdrawal reason</span>
                  <span className="text-[13px] text-text-primary">
                    {(proposal as import("../types/shared.js").WithdrawnProposalDomain).withdrawal_reason}
                  </span>
                </div>
              ) : null}
            </ContentPanel>

            <ContentPanel>
              <ContentPanel.Header>
                <ContentPanel.Title>Sections ({proposal.sections.length})</ContentPanel.Title>
              </ContentPanel.Header>
              <ContentPanel.Body className="p-0">
                {proposal.sections.length === 0 ? (
                  <p className="px-4 py-3 text-[13px] text-text-muted m-0">No sections.</p>
                ) : (
                  <table className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr className="bg-section-hover">
                        <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Document</th>
                        <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Section</th>
                        {hasHumanInvolvementScores ? (
                          <th className="text-center px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Human Involvement</th>
                        ) : null}
                        <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Agent writes</th>
                        <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Explanation</th>
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
                          <tr key={`${sectionDocPath}-${section.heading_path.join("/")}-${idx}`} className="border-t border-footer-border">
                            <td className="px-4 py-2">
                              <DocumentLinkWhenDisplayPathIsLiveDocPath displayPath={sectionDocPath} />
                            </td>
                            <td className="px-4 py-2 text-text-primary">{headingPathToLabel(section.heading_path)}</td>
                            {hasHumanInvolvementScores ? (
                              <td
                                className="px-4 py-2 text-center font-mono text-[12px]"
                                style={{ color: typeof score === "number" ? involvementColor(score) : undefined }}
                              >
                                {typeof score === "number" ? score.toFixed(2) : "—"}
                              </td>
                            ) : null}
                            <td className="px-4 py-2">
                              {canWrite ? (
                                <span className="text-status-green font-medium">Allowed</span>
                              ) : (
                                <span className="text-status-red font-medium">Blocked</span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-text-secondary">
                              {target?.message ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </ContentPanel.Body>
            </ContentPanel>

            {agentWritePolicy ? (
              <ContentPanel>
                <ContentPanel.Header>
                  <ContentPanel.Title>Agent Write Policy</ContentPanel.Title>
                </ContentPanel.Header>
                <ContentPanel.Body>
                  {/* Backend prose is the primary explanation (Area M). */}
                  <p className="m-0 mb-2 text-[13px] text-text-primary">{agentWritePolicy.message}</p>
                  <ul className="m-0 pl-5 text-[13px] text-text-secondary">
                    <li>Agents can write: {agentWritePolicy.canWrite ? "yes" : "no"}</li>
                    {hasHumanInvolvementScores ? (
                      <li>
                        Aggregate impact: {agentWritePolicy.details.aggregateImpact.toFixed(2)} / {agentWritePolicy.details.aggregateThreshold.toFixed(2)}
                      </li>
                    ) : null}
                    <li>Blocked sections: {agentWritePolicy.targets.filter((t) => !t.canWrite).length}</li>
                    <li>Allowed sections: {agentWritePolicy.targets.filter((t) => t.canWrite).length}</li>
                  </ul>
                </ContentPanel.Body>
              </ContentPanel>
            ) : null}

            {lockEvaluation && lockEvaluation.conflicts.length > 0 ? (
              <ContentPanel>
                <ContentPanel.Header>
                  <ContentPanel.Title>Lock Conflicts</ContentPanel.Title>
                </ContentPanel.Header>
                <ContentPanel.Body>
                  <p className="m-0 mb-2 text-[13px] text-text-primary">{lockEvaluation.message}</p>
                  <ul className="m-0 pl-5 text-[13px] text-text-secondary">
                    {lockEvaluation.conflicts.map((conflict, i) => (
                      <li key={`${proposalTargetKey(conflict.target)}-${i}`}>
                        {proposalTargetLabel(conflict.target)}: {conflict.message}
                      </li>
                    ))}
                  </ul>
                </ContentPanel.Body>
              </ContentPanel>
            ) : null}

            <ContentPanel>
              <ContentPanel.Header>
                <ContentPanel.Title>Affected Documents</ContentPanel.Title>
              </ContentPanel.Header>
              <ContentPanel.Body>
                {affectedDocs.length === 0 ? (
                  <p className="m-0 text-[13px] text-text-muted">None</p>
                ) : (
                  <ul className="m-0 pl-5">
                    {affectedDocs.map((docPath) => (
                      <li key={docPath}>
                        <DocumentLinkWhenDisplayPathIsLiveDocPath displayPath={docPath} />
                      </li>
                    ))}
                  </ul>
                )}
              </ContentPanel.Body>
            </ContentPanel>

            <ProposalTruthPanel proposal={proposal} />

            <div className="flex flex-wrap gap-2 mt-1">
              <button
                type="button"
                className="btn-secondary disabled:opacity-60"
                onClick={() => void loadProposal()}
                disabled={actionBusy || loading}
              >
                Refresh
              </button>
              {proposal.writer.type === "human" && proposal.status === "draft" ? (
                <button
                  type="button"
                  className="btn-secondary disabled:opacity-60"
                  onClick={handleAcquireLocks}
                  disabled={actionBusy || !proposal.sections.length}
                >
                  Lock Sections
                </button>
              ) : null}
              <button
                type="button"
                className="btn-primary disabled:opacity-60"
                onClick={handleCommit}
                disabled={actionBusy || (proposal.writer.type === "human" ? proposal.status !== "inprogress" : proposal.status !== "draft")}
              >
                Publish
              </button>
              <button
                type="button"
                className="btn-danger disabled:opacity-60"
                onClick={handleWithdraw}
                disabled={actionBusy || (proposal.status !== "draft" && proposal.status !== "inprogress")}
              >
                Withdraw
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
