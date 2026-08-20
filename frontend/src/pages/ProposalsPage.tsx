import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ProposalFilterBar } from "../components/ProposalFilterBar";
import { ContentPanel } from "../components/ContentPanel";
import { StatusPill } from "../components/StatusPill";
import { WriterIdentity } from "../components/WriterIdentity";
import { PageStatusBar } from "../components/PageStatusBar";
import { apiClient } from "../services/api-client";
import type { AnyProposal, UndecodableProposalRef } from "../types/shared.js";
import { proposalSectionDocPathForDisplay } from "../types/shared.js";
import { headingPathToLabel } from "./document-page-utils";
import { relativeTime } from "../utils/relativeTime";
import { filterProposals, STATUS_FILTERS, WRITER_FILTERS } from "../services/proposal-filter";
import {
  guidanceForDegradedDefects,
  guidanceForUndecodableDefect,
  type ProposalDefectGuidance,
} from "../services/proposal-defect-guidance";

function statusPillVariant(status: string): "green" | "yellow" | "red" | "muted" {
  switch (status) {
    case "draft": case "inprogress": case "committing": return "yellow";
    case "committed": return "green";
    case "withdrawn": return "red";
    default: return "muted";
  }
}

function isTerminalEmptyCommitted(proposal: AnyProposal): boolean {
  return proposal.status === "committed" && (proposal.degraded ?? []).includes("empty-committed");
}

function shortProposalId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-3)}` : id;
}

/** Data-root-relative proposal directory (`proposals/{status}/{id}`). */
function proposalStoreDir(status: string, id: string): string {
  return `proposals/${status}/${id}`;
}

function ProposalStoreDirPath({ status, id }: { status: string; id: string }) {
  const dir = proposalStoreDir(status, id);
  return (
    <div className="mt-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-red-700/80">
        On-disk directory
      </div>
      <code
        className="mt-0.5 block break-all rounded border border-red-200 bg-red-50/80 px-1.5 py-1 text-[11px] text-red-900"
        title="Relative to the server data root (KS_DATA_ROOT)"
      >
        {dir}
      </code>
    </div>
  );
}

/** Subtle divider: short horizontal rule when stacked; padded vertical on sm+. */
function AdminReviewDivider() {
  return (
    <>
      <div className="mx-2.5 my-0.5 h-px bg-red-300/70 sm:hidden" aria-hidden />
      <div className="hidden shrink-0 self-stretch py-2.5 sm:flex" aria-hidden>
        <div className="w-px bg-red-300/70" />
      </div>
    </>
  );
}

function AdminReviewGuidance({ guidance }: { guidance: ProposalDefectGuidance }) {
  return (
    <div className="min-w-0 flex-1 px-3 py-2">
      <div className="text-[12px] leading-[1.45] text-red-800">{guidance.explanation}</div>
      <div className="mt-2 text-[11px] italic leading-[1.45] text-red-700">
        {guidance.suggestedFix}
      </div>
    </div>
  );
}

export function ProposalsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [writerFilter, setWriterFilter] = useState<string>("All writers");
  const [query, setQuery] = useState("");
  const [proposals, setProposals] = useState<AnyProposal[]>([]);
  const [undecodable, setUndecodable] = useState<UndecodableProposalRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-(proposal,defect) autofix in-flight keys and per-proposal autofix errors.
  const [autofixing, setAutofixing] = useState<Set<string>>(new Set());
  const [autofixErrors, setAutofixErrors] = useState<Record<string, string>>({});
  const [forceCancelling, setForceCancelling] = useState<Set<string>>(new Set());
  const [forceCancelErrors, setForceCancelErrors] = useState<Record<string, string>>({});

  const handleAutofix = async (proposalId: string, detectorId: string) => {
    const key = `${proposalId}:${detectorId}`;
    setAutofixing((prev) => new Set(prev).add(key));
    setAutofixErrors((prev) => {
      const next = { ...prev };
      delete next[proposalId];
      return next;
    });
    try {
      const { proposal } = await apiClient.autofixProposalDefect(proposalId, detectorId);
      setProposals((prev) => prev.map((p) => (p.id === proposalId ? proposal : p)));
    } catch (err) {
      setAutofixErrors((prev) => ({
        ...prev,
        [proposalId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setAutofixing((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleForceCancel = async (proposalId: string) => {
    if (!window.confirm(`Force cancel proposal ${proposalId}? This cannot be undone.`)) return;
    setForceCancelling((prev) => new Set(prev).add(proposalId));
    setForceCancelErrors((prev) => {
      const next = { ...prev };
      delete next[proposalId];
      return next;
    });
    try {
      await apiClient.forceCancelProposal(
        proposalId,
        "Force-cancelled from the admin proposals page.",
      );
      const response = await apiClient.listAdminProposals();
      setProposals(response.proposals);
      setUndecodable(response.undecodable ?? []);
    } catch (err) {
      setForceCancelErrors((prev) => ({
        ...prev,
        [proposalId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setForceCancelling((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient.listAdminProposals()
      .then((response) => {
        if (!cancelled) {
          setProposals(response.proposals);
          setUndecodable(response.undecodable ?? []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const filteredProposals = useMemo(
    () => filterProposals(proposals, { statusFilter, writerFilter, query }),
    [proposals, statusFilter, writerFilter, query],
  );

  const filteredUndecodable = useMemo(() => {
    // Writer filter cannot apply — undecodable metas have no trusted writer identity.
    if (writerFilter !== "All writers") return [];
    const q = query.trim().toLowerCase();
    return undecodable.filter((entry) => {
      if (statusFilter === "Inflight"
        && entry.status !== "draft"
        && entry.status !== "inprogress"
        && entry.status !== "committing") return false;
      if (statusFilter === "Proposing" && entry.status !== "draft") return false;
      if (statusFilter === "Committed" && entry.status !== "committed") return false;
      if (statusFilter === "Cancelled" && entry.status !== "withdrawn") return false;
      if (!q) return true;
      return (
        entry.id.toLowerCase().includes(q)
        || entry.defect.toLowerCase().includes(q)
        || entry.raw_doc_paths.some((p) => p.toLowerCase().includes(q))
      );
    });
  }, [undecodable, statusFilter, writerFilter, query]);

  const degradedProposals = useMemo(
    () => proposals.filter((p) => (p.degraded ?? []).length > 0),
    [proposals],
  );
  const adminReviewCount = degradedProposals.length + undecodable.length;

  const inflight = proposals.filter(
    (p) => p.status === "draft"
      || p.status === "pending"
      || p.status === "inprogress"
      || p.status === "committing",
  ).length;
  const committed = proposals.filter((p) => p.status === "committed").length;
  const totalListed = proposals.length + undecodable.length;

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Proposals" backTo="/admin" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        {!loading && !error && adminReviewCount > 0 && (
          <div
            role="alert"
            data-testid="proposals-admin-review-banner"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-800"
          >
            <div className="font-semibold">
              {adminReviewCount} {adminReviewCount === 1 ? "proposal needs" : "proposals need"} admin review
            </div>
            <p className="mt-1 mb-2 text-[12px] text-red-700">
              These proposals failed strict decode or carry a degraded marker. Repairable defects can be
              autofixed below; undecodable metas need manual investigation on disk.
            </p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {degradedProposals.map((proposal) => {
                const defects = proposal.degraded ?? [];
                const terminal = isTerminalEmptyCommitted(proposal);
                const guidance = guidanceForDegradedDefects(defects);
                return (
                  <li
                    key={proposal.id}
                    className="flex flex-col rounded border border-red-200 bg-white/70 sm:flex-row"
                  >
                    <div className="min-w-0 flex-1 px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill variant={statusPillVariant(proposal.status)} showDot>
                          {proposal.status}
                        </StatusPill>
                        <Link
                          to={`/admin/proposals/${encodeURIComponent(proposal.id)}`}
                          className="font-mono text-[11px] font-medium text-red-900 underline"
                        >
                          {shortProposalId(proposal.id)}
                        </Link>
                        <WriterIdentity name={proposal.writer.displayName} kind={proposal.writer.type} />
                      </div>
                      <div className="mt-1 text-[12px] italic text-red-900">
                        &ldquo;{proposal.intent || "(no intent)"}&rdquo;
                      </div>
                      <div className="mt-1 text-[11px] text-red-700">
                        {terminal
                          ? "Terminal corrupt audit record — retained only for investigation."
                          : "Quarantined — cannot lock or commit until repaired."}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {defects.map((defect) => {
                          const key = `${proposal.id}:${defect}`;
                          const busy = autofixing.has(key);
                          if (defect === "empty-committed") {
                            return (
                              <span
                                key={defect}
                                className="rounded border border-red-300 bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800"
                              >
                                <code>{defect}</code>
                              </span>
                            );
                          }
                          return (
                            <button
                              key={defect}
                              type="button"
                              disabled={busy}
                              onClick={() => void handleAutofix(proposal.id, defect)}
                              className="rounded border border-red-300 bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800 hover:bg-red-200 disabled:opacity-60"
                            >
                              {busy ? `Autofixing ${defect}…` : `Autofix ${defect}`}
                            </button>
                          );
                        })}
                      </div>
                      {autofixErrors[proposal.id] ? (
                        <div className="mt-1 text-[11px] text-red-700">{autofixErrors[proposal.id]}</div>
                      ) : null}
                      <ProposalStoreDirPath status={proposal.status} id={proposal.id} />
                    </div>
                    <AdminReviewDivider />
                    <AdminReviewGuidance guidance={guidance} />
                  </li>
                );
              })}
              {undecodable.map((entry) => (
                <li
                  key={`undecodable:${entry.id}`}
                  className="flex flex-col rounded border border-red-200 bg-white/70 sm:flex-row"
                >
                  <div className="min-w-0 flex-1 px-2.5 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill variant="red" showDot>
                        {entry.status}
                      </StatusPill>
                      <span className="font-mono text-[11px] font-medium text-red-900">
                        {shortProposalId(entry.id)}
                      </span>
                      <span className="text-[11px] font-semibold text-red-800">Undecodable</span>
                    </div>
                    <div className="mt-1 text-[12px] text-red-700">{entry.defect}</div>
                    {entry.raw_doc_paths.length > 0 ? (
                      <div className="mt-1 font-mono text-[11px] text-red-700">
                        Paths: {entry.raw_doc_paths.join(", ")}
                      </div>
                    ) : null}
                    <ProposalStoreDirPath status={entry.status} id={entry.id} />
                  </div>
                  <AdminReviewDivider />
                  <AdminReviewGuidance guidance={guidanceForUndecodableDefect(entry.defect)} />
                </li>
              ))}
            </ul>
          </div>
        )}

        <ProposalFilterBar>
          <ProposalFilterBar.Group>
            {STATUS_FILTERS.map((f) => (
              <ProposalFilterBar.Option key={f} active={statusFilter === f} onClick={() => setStatusFilter(f)}>
                {f}
              </ProposalFilterBar.Option>
            ))}
          </ProposalFilterBar.Group>
          <ProposalFilterBar.Group>
            {WRITER_FILTERS.map((f) => (
              <ProposalFilterBar.Option key={f} active={writerFilter === f} onClick={() => setWriterFilter(f)}>
                {f}
              </ProposalFilterBar.Option>
            ))}
          </ProposalFilterBar.Group>
          <ProposalFilterBar.SearchField
            placeholder="Search intent..."
            value={query}
            onChange={setQuery}
          />
        </ProposalFilterBar>

        {loading && <p className="text-xs text-text-muted">Loading proposals...</p>}
        {error && <p className="text-error text-xs">{error}</p>}

        {!loading && !error && (
          <ContentPanel>
            <ContentPanel.Body className="p-0">
              {filteredProposals.length === 0 && filteredUndecodable.length === 0 ? (
                <div className="p-4 text-xs text-text-muted">No proposals found.</div>
              ) : (
                <>
                {filteredUndecodable.map((entry) => (
                  <div
                    key={`undecodable:${entry.id}`}
                    data-testid="proposal-row-undecodable"
                    className="block border-b border-red-200 bg-red-50"
                    style={{
                      padding: "14px 16px",
                      borderLeft: "3px solid var(--color-status-red, #dc2626)",
                    }}
                  >
                    <div className="mb-2 rounded border border-red-200 bg-white/70 px-2 py-1.5">
                      <div className="text-[11px] font-semibold text-red-800">
                        Undecodable — corrupt proposal meta
                      </div>
                      <div className="mt-1 text-[11px] text-red-700">{entry.defect}</div>
                      {entry.raw_doc_paths.length > 0 ? (
                        <div className="mt-1 text-[11px] text-red-700 font-mono">
                          {entry.raw_doc_paths.join(", ")}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <StatusPill variant="red" showDot>
                        {entry.status}
                      </StatusPill>
                      <span className="code-inline" style={{ fontSize: "11px", padding: "1px 5px" }}>
                        {shortProposalId(entry.id)}
                      </span>
                    </div>
                  </div>
                ))}
                {filteredProposals.map((proposal) => {
                  const degraded = proposal.degraded ?? [];
                  const isDegraded = degraded.length > 0;
                  return (
                  <Link
                    key={proposal.id}
                    to={`/admin/proposals/${encodeURIComponent(proposal.id)}`}
                    data-testid={isDegraded ? "proposal-row-degraded" : "proposal-row"}
                    className={`block border-b last:border-b-0 ${isDegraded ? "border-red-200 bg-red-50 hover:bg-red-100" : "border-[#f5f2ed] hover:bg-[#faf8f5]"}`}
                    style={{
                      padding: "14px 16px",
                      textDecoration: "none",
                      opacity: proposal.status === "withdrawn" ? 0.65 : 1,
                      ...(isDegraded ? { borderLeft: "3px solid var(--color-status-red, #dc2626)" } : {}),
                    }}
                  >
                    {isDegraded ? (
                      <div className="mb-2 rounded border border-red-200 bg-white/70 px-2 py-1.5">
                        <div className="text-[11px] font-semibold text-red-800">
                          {isTerminalEmptyCommitted(proposal)
                            ? "Degraded — terminal corrupt audit record"
                            : "Degraded — repair required before lock or commit"}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {degraded.map((defect) => {
                            const key = `${proposal.id}:${defect}`;
                            const busy = autofixing.has(key);
                            if (defect === "empty-committed") {
                              return (
                                <span
                                  key={defect}
                                  className="text-[11px] font-medium px-2 py-0.5 rounded border border-red-300 bg-red-100 text-red-800"
                                >
                                  <code>{defect}</code> — terminal corrupt audit record
                                </span>
                              );
                            }
                            return (
                              <button
                                key={defect}
                                type="button"
                                disabled={busy}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void handleAutofix(proposal.id, defect);
                                }}
                                className="text-[11px] font-medium px-2 py-0.5 rounded border border-red-300 bg-red-100 text-red-800 hover:bg-red-200 disabled:opacity-60"
                              >
                                {busy ? `Autofixing ${defect}…` : `Autofix ${defect}`}
                              </button>
                            );
                          })}
                        </div>
                        {autofixErrors[proposal.id] ? (
                          <div className="mt-1 text-[11px] text-red-700">{autofixErrors[proposal.id]}</div>
                        ) : null}
                      </div>
                    ) : null}

                    {/* Top row */}
                    <div className="flex items-center gap-2 mb-1.5">
                      <StatusPill variant={statusPillVariant(proposal.status)} showDot>
                        {proposal.status}
                      </StatusPill>
                      <WriterIdentity name={proposal.writer.displayName} kind={proposal.writer.type} />
                      <span className="code-inline" style={{ fontSize: "11px", padding: "1px 5px" }}>
                        {shortProposalId(proposal.id)}
                      </span>
                      <span className="ml-auto text-[11px] text-[#b8b2a8]">
                        {relativeTime(proposal.created_at)}
                      </span>
                    </div>

                    {/* Intent */}
                    <div className="text-[13px] text-text-primary leading-[1.45] mb-2 italic">
                      "{proposal.intent}"
                    </div>

                    {/* Targets */}
                    <div className="flex flex-wrap gap-1">
                      {(() => {
                        const byDoc = new Map<string, Array<{ heading: string; headingPathLength: number }>>();
                        for (const s of proposal.sections) {
                          const docName = proposalSectionDocPathForDisplay(s);
                          const existing = byDoc.get(docName) ?? [];
                          const heading = headingPathToLabel(s.heading_path);
                          const headingPathLength = s.heading_path.length;
                          existing.push({ heading, headingPathLength });
                          byDoc.set(docName, existing);
                        }
                        return Array.from(byDoc.entries()).map(([docName, sections]) => (
                          <span
                            key={docName}
                            className="inline-flex flex-col gap-0.5"
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 11,
                              color: "var(--color-text-secondary)",
                              background: "#f7f5f1",
                              padding: "4px 8px",
                              borderRadius: 5,
                            }}
                          >
                            <span>{docName}</span>
                            <span className="flex flex-wrap gap-1 mt-0.5">
                              {sections.map((s, i) => (
                                <span
                                  key={i}
                                  className="text-[10px] font-medium"
                                  style={{
                                    padding: "1px 5px",
                                    borderRadius: 3,
                                    background: s.headingPathLength <= 1 ? "#f0ede8" : s.headingPathLength <= 2 ? "#e8e4de" : "#ddd8d0",
                                    color: "var(--color-text-secondary)",
                                  }}
                                >
                                  {s.heading}
                                </span>
                              ))}
                            </span>
                          </span>
                        ));
                      })()}
                    </div>

                    {/* Bottom row */}
                    <div className="flex items-center gap-2 mt-2 text-[11px] text-text-muted">
                      <span>{proposal.sections.length} write targets</span>
                      {(proposal.status === "draft"
                        || proposal.status === "pending"
                        || proposal.status === "inprogress") ? (
                        <button
                          type="button"
                          disabled={forceCancelling.has(proposal.id)}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleForceCancel(proposal.id);
                          }}
                          className="ml-auto rounded border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-800 hover:bg-red-100 disabled:opacity-60"
                        >
                          {forceCancelling.has(proposal.id) ? "Force cancelling…" : "Force cancel"}
                        </button>
                      ) : null}
                    </div>
                    {forceCancelErrors[proposal.id] ? (
                      <div className="mt-1 text-[11px] text-red-700">
                        {forceCancelErrors[proposal.id]}
                      </div>
                    ) : null}
                  </Link>
                  );
                })}
                </>
              )}
            </ContentPanel.Body>
            <ContentPanel.Summary>
              Showing {filteredProposals.length + filteredUndecodable.length} of {totalListed} proposals
              {undecodable.length > 0 ? ` · ${undecodable.length} undecodable` : ""}
              {" · "}Filtered: {statusFilter}, {writerFilter}
            </ContentPanel.Summary>
          </ContentPanel>
        )}
      </div>
      <PageStatusBar
        items={[
          "Proposals",
          `${totalListed} total`,
          `${inflight} inflight`,
          `${committed} committed`,
          ...(undecodable.length > 0 ? [`${undecodable.length} undecodable`] : []),
        ]}
      />
    </div>
  );
}
