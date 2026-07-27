import { headingPathToLabel } from "../pages/document-page-utils";
import type { ClaimedSection } from "../services/live-section-replica";

/**
 * A history-panel row representing the document's uncommitted live proposal —
 * distinct from a canonical commit row (FP14). It has NO git SHA and NO restore
 * capability; it is a live, in-flight change-set, not a version in history.
 */
export interface UnpublishedHistoryRow {
  kind: "unpublished";
  proposalId: string;
  changedSectionCount: number;
  /** Display labels for the claimed sections (heading paths), for the row copy. */
  sectionLabels: string[];
}

/**
 * Build the unpublished row from the ORDERED live proposal snapshot already held
 * by the replica (FP15) — the same claim set finalization publishes. Does NOT
 * fetch a separate proposal snapshot for display.
 */
export function buildUnpublishedHistoryRow(
  proposalId: string,
  claimedSections: readonly ClaimedSection[],
): UnpublishedHistoryRow {
  return {
    kind: "unpublished",
    proposalId,
    changedSectionCount: claimedSections.length,
    sectionLabels: claimedSections.map((c) => headingPathToLabel([...c.headingPath])),
  };
}

/** Concise one-line description of the unpublished change-set (FP15). */
export function describeUnpublishedHistoryRow(row: UnpublishedHistoryRow): string {
  const n = row.changedSectionCount;
  const noun = n === 1 ? "section" : "sections";
  if (row.sectionLabels.length === 0) {
    return `${n} unpublished changed ${noun}`;
  }
  const shown = row.sectionLabels.slice(0, 3).join(", ");
  const more = row.sectionLabels.length > 3 ? `, +${row.sectionLabels.length - 3} more` : "";
  return `${n} unpublished changed ${noun}: ${shown}${more}`;
}
