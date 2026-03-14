// ─── Writer Identity ───────────────────────────────────────────────

export type WriterType = "human" | "agent";

export interface WriterIdentity {
  id: string;
  type: WriterType;
  displayName: string;
  email?: string;
}

// ─── Section References ────────────────────────────────────────────

export type DocPath = string;
export type HeadingPath = string[];
export type ProposalId = string;

export interface SectionTargetRef {
  doc_path: string;
  heading_path: string[];
}

// ─── Section Key Functions ─────────────────────────────────────────
// Single source of truth for key separator format. Zero dependencies.

/** Join a heading path into a single string key. e.g. ["A", "B"] → "A>>B" */
export function sectionHeadingKey(headingPath: string[]): string {
  return headingPath.join(">>");
}

/** Build a globally unique section key. e.g. ("doc.md", ["A"]) → "doc.md::A" */
export function sectionGlobalKey(docPath: string, headingPath: string[]): string {
  return docPath + "::" + sectionHeadingKey(headingPath);
}

/** Build a fragment key for a heading path. Root (empty path) returns "__root__". */
export function sectionFragmentKey(headingPath: string[]): string {
  if (headingPath.length === 0) return "__root__";
  return "section::" + sectionHeadingKey(headingPath);
}

// ─── Section Score Snapshot ────────────────────────────────────────

/** Keyed by section key → score at the time of evaluation/commit. */
export type SectionScoreSnapshot = Record<string, number>;

// ─── Human-Involvement Presets ───────────────────────────────────

export type HumanHumanInvolvementPresetName = "yolo" | "aggressive" | "eager" | "conservative";

export interface HumanInvolvementPreset {
  name: HumanHumanInvolvementPresetName;
  midpoint_seconds: number;
  steepness: number;
  description: string;
}

export const HUMAN_INVOLVEMENT_PRESETS: Record<HumanHumanInvolvementPresetName, HumanInvolvementPreset> = {
  yolo: {
    name: "yolo",
    midpoint_seconds: 30,
    steepness: 3.0,
    description:
      "Almost no protection. Agents can write within 30 seconds of human activity. Only use for solo work or demos.",
  },
  aggressive: {
    name: "aggressive",
    midpoint_seconds: 300,
    steepness: 2.0,
    description:
      "Agents back off for about 5 minutes after human activity. Good for fast-paced teams comfortable with agent autonomy.",
  },
  eager: {
    name: "eager",
    midpoint_seconds: 7200,
    steepness: 1.2,
    description:
      "Agents wait about 2 hours after human activity. Balanced setting for most teams.",
  },
  conservative: {
    name: "conservative",
    midpoint_seconds: 28800,
    steepness: 0.9,
    description:
      "Agents wait about 8 hours after human activity. Maximum protection for sensitive documents.",
  },
};

// ─── Admin Configuration ───────────────────────────────────────────

export interface AdminConfig {
  humanInvolvement_preset: HumanHumanInvolvementPresetName;
  humanInvolvement_midpoint_seconds: number;
  humanInvolvement_steepness: number;
  snapshot_enabled: boolean;
}

// ─── Proposal Model (v3 — 4-state lifecycle) ──────────────────────

export type ProposalStatus = "pending" | "committing" | "committed" | "withdrawn";

/** What is stored in the proposal JSON file on disk. */
export interface ProposalFile {
  id: ProposalId;
  writer: WriterIdentity;
  intent: string;
  sections: ProposalSection[];
  created_at: string;
  committed_head?: string;
  humanInvolvement_at_commit?: Record<string, number>;
  withdrawal_reason?: string;
}

/** What the API returns (enriched at read time). */
export interface Proposal extends ProposalFile {
  status: ProposalStatus;
  humanInvolvement_evaluation?: ProposalHumanInvolvementEvaluation;
}

export interface ProposalSection {
  doc_path: string;
  heading_path: string[];
  justification?: string;
  humanInvolvement_score?: number;
  blocked?: boolean;
}

export interface ProposalHumanInvolvementEvaluation {
  all_sections_accepted: boolean;
  aggregate_impact: number;
  aggregate_threshold: number;
  blocked_sections: EvaluatedSection[];
  passed_sections: EvaluatedSection[];
}

export interface EvaluatedSection {
  doc_path: string;
  heading_path: string[];
  humanInvolvement_score: number;
  blocked: boolean;

  justification?: string;
  crdt_session_active?: boolean;
}

/** Alias: per-section verdict from SectionGuard evaluation. */
export type SectionVerdict = EvaluatedSection;

/** Alias: batch verdict from SectionGuard.evaluateBatch(). */
export type BatchVerdict = ProposalHumanInvolvementEvaluation;

// ─── Section State / Activity ──────────────────────────────────────

export interface SectionState {
  doc_path: string;
  heading_path: string[];
  last_human_commit_sha: string | null;
  last_editor_id: string | null;
  last_editor_type: WriterType | null;
  last_editor_display_name: string | null;
  crdt_session_active: boolean;
  crdt_holder_count: number;
  diverged: boolean;
  base_head: string | null;
  humanInvolvement_score: number;
}

// ─── Heatmap ───────────────────────────────────────────────────────

export interface HeatmapEntry {
  doc_path: string;
  heading_path: string[];
  humanInvolvement_score: number;
  crdt_session_active: boolean;
  last_human_commit_sha: string | null;

  last_commit_author: string | null;
  last_commit_timestamp: string | null;
}

export interface GetHeatmapResponse {
  preset: HumanHumanInvolvementPresetName;
  humanInvolvement_midpoint_seconds: number;
  humanInvolvement_steepness: number;
  sections: HeatmapEntry[];
}

// ─── Mirror (Dirty State) ──────────────────────────────────────────

export interface DirtySection {
  heading_path: string[];
  base_head: string;
  change_magnitude: number;
}

export interface DirtyDocument {
  doc_path: string;
  dirty_sections: DirtySection[];
}

export interface WriterDirtyState {
  writer_id: string;
  documents: DirtyDocument[];
}

// ─── Document Types ────────────────────────────────────────────────

export interface DocumentTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: DocumentTreeEntry[];
}

export interface DocStructureNode {
  heading: string;
  level: number;
  children: DocStructureNode[];
}

export interface SectionMeta {
  heading_path: string[];
  humanInvolvement_score: number;
  crdt_session_active: boolean;
  section_length_warning: boolean;
  word_count: number;
}

export interface GetDocumentResponse {
  doc_path: string;
  content: string;
  head_sha: string;
  sections_meta?: SectionMeta[];
}

export interface GetDocumentSectionsResponse {
  doc_path: string;
  sections: Array<{
    heading: string;
    heading_path: string[];
    depth: number;
    content: string;
    humanInvolvement_score: number;
    crdt_session_active: boolean;
    section_length_warning: boolean;
    word_count: number;
    /** Section filename (e.g. "sec_abc123def.md"). Used by frontend to build
     *  stable fragment keys that survive heading renames. */
    section_file: string;
  }>;
}

export interface GetDocumentsTreeResponse {
  tree: DocumentTreeEntry[];
}

export interface ReadDocStructureResponse {
  doc_path: string;
  structure: DocStructureNode[];
}

// ─── Section Read/Write ────────────────────────────────────────────

export interface ReadSectionResponse {
  doc_path: string;
  heading_path: string[];
  content: string;
  head_sha: string;
}

// ─── Changes Since ─────────────────────────────────────────────────

export interface ChangesSinceResponse {
  since_sha: string;
  current_sha: string;
  changed: boolean;
  changed_sections: SectionTargetRef[];
}

// ─── Proposal API ──────────────────────────────────────────────────

/** Evaluation outcome: did all sections pass, or were some blocked? */
export type ProposalOutcome = "accepted" | "blocked";

export interface CreateProposalRequest {
  intent: string;
  sections: Array<{
    doc_path: string;
    heading_path: string[];
    content: string;
    justification?: string;
  }>;
}

export interface CreateProposalResponse {
  proposal_id: ProposalId;
  status: ProposalStatus;
  outcome: ProposalOutcome;
  committed_head?: string;
  evaluation: ProposalHumanInvolvementEvaluation;
  sections: EvaluatedSection[];
}

export interface UpdateProposalRequest {
  intent?: string;
  sections: Array<{
    doc_path: string;
    heading_path: string[];
    content: string;
    justification?: string;
  }>;
}

export interface CommitProposalResponse {
  proposal_id: ProposalId;
  status: ProposalStatus;
  outcome: ProposalOutcome;
  committed_head?: string;
  evaluation: ProposalHumanInvolvementEvaluation;
  sections: EvaluatedSection[];
}

export interface WithdrawProposalResponse {
  proposal_id: ProposalId;
  status: "withdrawn";
}

export interface ReadProposalResponse {
  proposal: Proposal;
}

export interface ListProposalsResponse {
  proposals: Proposal[];
}

// ─── Publish ───────────────────────────────────────────────────────

export interface PublishRequest {
  doc_path?: string;
  heading_paths?: string[][];
}

export interface PublishResponse {
  committed_head: string;
  sections_published: SectionTargetRef[];
}

// ─── Activity ──────────────────────────────────────────────────────

export type ActivityItemSource = "agent_proposal" | "human_auto_commit" | "human_publish";

export interface ActivityItem {
  id: string;
  timestamp: string;
  source: ActivityItemSource;
  writer_id: string;
  writer_type: WriterType;
  writer_display_name: string;
  commit_sha: string;
  sections: SectionTargetRef[];
  intent?: string;
}

export interface GetActivityResponse {
  items: ActivityItem[];
}

// ─── Admin ─────────────────────────────────────────────────────────

export interface GetAdminSnapshotHealthResponse {
  snapshot_enabled: boolean;
  snapshots_exist: boolean;
  snapshot_stale: boolean;
}

// ─── Create Document ───────────────────────────────────────────

export interface CreateDocumentResponse {
  doc_path: string;
}

// ─── Auth ──────────────────────────────────────────────────────────

export type LoginProvider = "single_user" | "credentials" | "oidc" | "hybrid";

export interface AuthUser {
  id: string;
  type: WriterType;
  displayName: string;
  email?: string;
}

export interface SessionInfoResponse {
  authenticated: boolean;
  user?: AuthUser;
  login_providers?: LoginProvider[];
}

// ─── API Errors ────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  details?: unknown;
}

// ─── WebSocket Events ──────────────────────────────────────────────

export interface ContentCommittedEvent {
  type: "content:committed";
  doc_path: string;
  sections: SectionTargetRef[];
  commit_sha: string;
  source: ActivityItemSource;
  writer_id: string;
  writer_display_name: string;
}

export interface DirtyChangedEvent {
  type: "dirty:changed";
  writer_id: string;
  doc_path: string;
  heading_path: string[];
  dirty: boolean;
  base_head: string | null;
  committed_head?: string;
}

export interface AgentReadingEvent {
  type: "agent:reading";
  actor_id: string;
  actor_display_name: string;
  doc_path: string;
  heading_paths: string[][];
}

export interface PresenceEditingEvent {
  type: "presence:editing";
  writer_id: string;
  writer_display_name: string;
  doc_path: string;
  heading_path: string[];
}

export interface PresenceDoneEvent {
  type: "presence:done";
  writer_id: string;
  doc_path: string;
  heading_path: string[];
}

export interface DocStructureChangedEvent {
  type: "doc:structure-changed";
  doc_path: string;
}

export interface SessionFlushedEvent {
  type: "session:flushed";
  doc_path: string;
}

export interface DocRenamedEvent {
  type: "doc:renamed";
  old_path: string;
  new_path: string;
  committed_head: string;
}

export interface ProposalPendingEvent {
  type: "proposal:pending";
  proposal_id: string;
  doc_path: string;
  heading_paths: string[][];
  writer_id: string;
  writer_display_name: string;
  intent: string;
}

export interface ProposalWithdrawnEvent {
  type: "proposal:withdrawn";
  proposal_id: string;
  doc_path: string;
  heading_paths: string[][];
}

export type WsServerEvent =
  | ContentCommittedEvent
  | DirtyChangedEvent
  | AgentReadingEvent
  | PresenceEditingEvent
  | PresenceDoneEvent
  | DocStructureChangedEvent
  | SessionFlushedEvent
  | DocRenamedEvent
  | ProposalPendingEvent
  | ProposalWithdrawnEvent;

// ─── WebSocket Client Messages ─────────────────────────────────────

export interface WsSubscribeMessage {
  action: "subscribe";
  doc_path: string;
}

export interface WsUnsubscribeMessage {
  action: "unsubscribe";
  doc_path: string;
}

export interface WsFocusSectionMessage {
  action: "focus_section";
  doc_path: string;
  heading_path: string[];
}

export interface WsBlurSectionMessage {
  action: "blur_section";
  doc_path: string;
  heading_path: string[];
}

export interface WsSessionDepartureMessage {
  action: "session_departure";
  doc_path: string;
}

export type WsClientMessage =
  | WsSubscribeMessage
  | WsUnsubscribeMessage
  | WsFocusSectionMessage
  | WsBlurSectionMessage
  | WsSessionDepartureMessage;
