import type { AnyProposal } from "../types/shared.js";

export const STATUS_FILTERS = ["All", "Inflight", "Proposing", "Committed", "Cancelled"] as const;
export const WRITER_FILTERS = ["All writers", "Human", "Agent"] as const;

export interface ProposalFilterOptions {
  statusFilter: string;
  writerFilter: string;
  query: string;
}

/**
 * Pure predicate filter for proposals. Combines status, writer, and free-text query
 * filters. The query matches against `intent` and `id` case-insensitively as a literal
 * substring (after trimming whitespace).
 */
export function filterProposals(proposals: AnyProposal[], opts: ProposalFilterOptions): AnyProposal[] {
  const { statusFilter, writerFilter, query } = opts;
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
    const trimmed = query.trim();
    if (trimmed) {
      const q = trimmed.toLowerCase();
      if (!p.intent.toLowerCase().includes(q) && !p.id.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}
