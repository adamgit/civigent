import type { ActivityItem, AnyProposal } from "../types/shared.js";

/**
 * Trims whitespace, drops empty entries, dedupes, and preserves first-seen order.
 */
export function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Concatenates localDocs + flat doc_paths from activity sections + flat doc_paths
 * from proposal sections, then dedupes preserving first-seen order. localDocs come
 * first so their ordering wins on overlap.
 */
export function mergeKnownDocPaths(
  localDocs: string[],
  activityItems: ActivityItem[],
  proposals: AnyProposal[],
): string[] {
  const fromActivity = activityItems.flatMap((item) => item.sections.map((s) => s.doc_path));
  const fromProposals = proposals.flatMap((proposal) => proposal.sections.map((s) => s.doc_path));
  return uniquePreserveOrder([...localDocs, ...fromActivity, ...fromProposals]);
}

/**
 * Case-insensitive substring filter on the trimmed query. An empty query returns
 * the input unchanged. The query is treated as a literal substring, not a regex.
 */
export function filterDocsByQuery(docs: string[], query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return docs;
  return docs.filter((docPath) => docPath.toLowerCase().includes(normalized));
}
