export interface DiagLayerStatus {
  exists: boolean;
  byteLength: number | null;
  contentPreview: string | null;
  error: string | null;
}

/**
 * One diagnostics row. `fragmentKey` is the PHYSICAL identity — one row per
 * unique physical section (there is a 1:1 mapping between fragmentKey and
 * sectionFile via `fragmentKeyFromSectionFile`). `headingKey` / `headingPath`
 * are addressing DATA carried alongside; multiple rows can share them when the
 * canonical layout contains duplicate heading paths (which the duplicate-
 * heading-paths / duplicate-sibling-headings checks flag as corruption). The
 * diagnostics UI keys rows by `fragmentKey` so a physical duplicate is not
 * silently collapsed into a single logical row.
 */
export interface DiagSectionLayerInfo {
  /** Physical identity — one row per unique section body file. */
  fragmentKey: string;
  /** Heading key (`headingPath.join(">>")`) — data, not identity. */
  headingKey: string;
  /** Heading path — data, not identity. */
  headingPath: string[];
  liveHeadingPath: string[] | null;
  liveHeadingKey: string | null;
  /** Canonical section-file name (empty when the row is CRDT-only). */
  sectionFile: string;
  isSubSkeleton: boolean;
  canonical: DiagLayerStatus;
  /** Effective inprogress-proposal body for this section (canonical + proposal
   *  overlay through the same reader every proposal read uses). Durable saved
   *  state — a refreshed client with no live CRDT reconstructs from here. */
  proposal: DiagLayerStatus;
  crdt: DiagLayerStatus;
  winner: string;
  gitHistoryExists?: boolean | null;
  error?: string;
}

export interface DiagHealthCheck {
  category: string;
  name: string;
  pass: boolean;
  detail?: string;
}

export interface DiagSummary {
  top_level_entries: number | null;
  recursive_structural_entries: number | null;
  recursive_content_sections: number | null;
  recursive_subskeleton_parents: number | null;
  recursive_max_heading_path_length: number | null;
  /** Physical body files walked from the recursive skeleton. */
  physical_section_count: number | null;
  /** Distinct heading paths across physical files (the heading-key-map size). */
  logical_section_count: number | null;
  /** Sections returned by the normal document/section API surface. */
  api_section_count: number | null;
}

export interface DiagRestoreProvenance {
  current_head_sha: string | null;
  last_restore_commit_sha: string | null;
  last_restore_target_sha: string | null;
  target_top_level_entries: number | null;
  target_recursive_content_sections: number | null;
  recursive_content_match: boolean | null;
  current_only_heading_keys: string[];
  target_only_heading_keys: string[];
}

/**
 * Backend-reported invalid/error state visible to the diagnostics panel. Kept
 * as a discriminated shape so `kind` says where the failure lives ("live" =
 * transient live CRDT error; "proposal" or "canonical" = durable on-disk
 * corruption). `null` when nothing is degraded. The panel surfaces this even
 * when the section-layer table looks empty, so a corrupt-but-quiet document
 * still reads as broken. Populated from signals that already exist (degraded
 * proposals, live-session inspection failures); reserved to expand as backend
 * error state grows richer.
 */
export type DiagBackendStateKind = "live" | "proposal" | "canonical";
export interface DiagBackendState {
  kind: DiagBackendStateKind;
  message: string;
  details: string[];
}

export interface DocDiagnosticsResponse {
  doc_path: string;
  checks: DiagHealthCheck[];
  sections: DiagSectionLayerInfo[];
  summary: DiagSummary;
  restore_provenance: DiagRestoreProvenance;
  /** Backend-reported invalid/error signals aggregated for this document, or
   *  `null` when nothing is degraded. */
  backend_states: DiagBackendState[];
}
