export interface DiagLayerStatus {
  exists: boolean;
  byteLength: number | null;
  contentPreview: string | null;
  error: string | null;
}

export interface DiagSectionLayerInfo {
  headingKey: string;
  headingPath: string[];
  sectionFile: string;
  isSubSkeleton: boolean;
  canonical: DiagLayerStatus;
  overlay: DiagLayerStatus;
  fragment: DiagLayerStatus;
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
  recursive_max_depth: number | null;
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

export interface DocDiagnosticsResponse {
  doc_path: string;
  checks: DiagHealthCheck[];
  sections: DiagSectionLayerInfo[];
  summary: DiagSummary;
  restore_provenance: DiagRestoreProvenance;
}
