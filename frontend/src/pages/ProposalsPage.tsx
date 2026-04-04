import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ProposalFilterBar } from "../components/ProposalFilterBar";
import { ContentPanel } from "../components/ContentPanel";
import { StatusPill } from "../components/StatusPill";
import { WriterIdentity } from "../components/WriterIdentity";
import { PageStatusBar } from "../components/PageStatusBar";
import { apiClient } from "../services/api-client";
import type { AnyProposal, ProposalStatus } from "../types/shared.js";
import { headingPathToLabel } from "./document-page-utils";
import { relativeTime } from "../utils/relativeTime";

function statusPillVariant(status: string): "green" | "yellow" | "red" | "muted" {
  switch (status) {
    case "draft": case "inprogress": case "committing": return "yellow";
    case "committed": return "green";
    case "withdrawn": return "red";
    default: return "muted";
  }
}

const STATUS_FILTERS = ["All", "Inflight", "Proposing", "Committed", "Cancelled"] as const;
const WRITER_FILTERS = ["All writers", "Human", "Agent"] as const;

export function ProposalsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("All");
  const [writerFilter, setWriterFilter] = useState<string>("All writers");
  const [query, setQuery] = useState("");
  const [proposals, setProposals] = useState<AnyProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient.listProposals()
      .then((response) => {
        if (!cancelled) {
          setProposals(response.proposals);
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

  const filteredProposals = useMemo(() => {
    return proposals.filter((p) => {
      // Status filter
      if (statusFilter === "Inflight" && p.status !== "draft" && p.status !== "inprogress" && p.status !== "committing") return false;
      if (statusFilter === "Proposing" && p.status !== "draft") return false;
      if (statusFilter === "Committed" && p.status !== "committed") return false;
      if (statusFilter === "Cancelled" && p.status !== "withdrawn") return false;
      // Writer filter
      if (writerFilter === "Human" && p.writer.type !== "human") return false;
      if (writerFilter === "Agent" && p.writer.type !== "agent") return false;
      // Search
      if (query.trim()) {
        const q = query.toLowerCase();
        if (!p.intent.toLowerCase().includes(q) && !p.id.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [proposals, statusFilter, writerFilter, query]);

  const inflight = proposals.filter((p) => p.status === "draft" || p.status === "committing").length;
  const committed = proposals.filter((p) => p.status === "committed").length;

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Proposals" backTo="/" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
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
              {filteredProposals.length === 0 ? (
                <div className="p-4 text-xs text-text-muted">No proposals found.</div>
              ) : (
                filteredProposals.map((proposal) => (
                  <Link
                    key={proposal.id}
                    to={`/proposals/${encodeURIComponent(proposal.id)}`}
                    className="block border-b border-[#f5f2ed] hover:bg-[#faf8f5] last:border-b-0"
                    style={{
                      padding: "14px 16px",
                      textDecoration: "none",
                      opacity: proposal.status === "withdrawn" ? 0.65 : 1,
                    }}
                  >
                    {/* Top row */}
                    <div className="flex items-center gap-2 mb-1.5">
                      <StatusPill variant={statusPillVariant(proposal.status)} showDot>
                        {proposal.status}
                      </StatusPill>
                      <WriterIdentity name={proposal.writer.displayName} kind={proposal.writer.type} />
                      <span className="code-inline" style={{ fontSize: "11px", padding: "1px 5px" }}>
                        {proposal.id.length > 14 ? `${proposal.id.slice(0, 8)}…${proposal.id.slice(-3)}` : proposal.id}
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
                        const byDoc = new Map<string, Array<{ heading: string; level: number }>>();
                        for (const s of proposal.sections) {
                          const docName = s.doc_path;
                          const existing = byDoc.get(docName) ?? [];
                          const heading = headingPathToLabel(s.heading_path);
                          const level = s.heading_path.length;
                          existing.push({ heading, level });
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
                                    background: s.level <= 1 ? "#f0ede8" : s.level <= 2 ? "#e8e4de" : "#ddd8d0",
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
                    </div>
                  </Link>
                ))
              )}
            </ContentPanel.Body>
            <ContentPanel.Summary>
              Showing {filteredProposals.length} of {proposals.length} proposals · Filtered: {statusFilter}, {writerFilter}
            </ContentPanel.Summary>
          </ContentPanel>
        )}
      </div>
      <PageStatusBar
        items={[
          "Proposals",
          `${proposals.length} total`,
          `${inflight} inflight`,
          `${committed} committed`,
        ]}
      />
    </div>
  );
}
