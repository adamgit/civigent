/**
 * Cold seed markdown for a section.
 *
 * The redesign makes the `LiveSectionReplica` the SOLE live display authority:
 * live/cold paint on document pages goes through `useLiveSectionReplica().paintMarkdown(id, seed)`
 * (live fragment after an authoritative bootstrap, this cold seed otherwise). There
 * is deliberately NO "section + store → markdown" live-display API anymore — a store
 * parameter here would reintroduce the dual-authority understudy the redesign kills.
 *
 * This helper is therefore cold-only: it returns the section's REST/bootstrap seed
 * text verbatim and never reads a Y.Doc fragment. Callers that need the LIVE body use
 * the replica (`paintMarkdown` / `requireLiveSection().readMarkdown()`); this is only
 * the fallback for the pre-bootstrap / off-topology cold case.
 */

export interface ColdSeedSection {
  content: string;
}

/** The cold seed text to paint before the live replica is authoritative. */
export function coldSeedMarkdown(section: ColdSeedSection): string {
  return typeof section.content === "string" ? section.content : "";
}
