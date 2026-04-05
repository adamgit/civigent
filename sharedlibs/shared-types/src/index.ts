// ─── Writer Identity ───────────────────────────────────────────────

/**
 * Authoritative writer identity enum emitted by backend APIs/events.
 * Frontends must treat any non-enum runtime value as UNKNOWN when consuming
 * untyped payloads (e.g. legacy/history endpoints) and surface the raw value.
 */
export type WriterType = "human" | "agent";
export type AttributionWriterType = WriterType | "unknown";

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

/**
 * SectionTarget — discriminated union for targeting a section.
 * Used in MCP tool inputs and API boundaries.
 */
export type SectionTarget =
  | { kind: "before_first_heading" }
  | { kind: "heading_path"; heading_path: string[] };

/** Convert SectionTarget to heading path for internal resolution. */
export function sectionTargetToHeadingPath(target: SectionTarget): string[] {
  return target.kind === "before_first_heading" ? [] : target.heading_path;
}

/** Convert heading path to SectionTarget for wire format parsing. */
export function headingPathToSectionTarget(hp: string[]): SectionTarget {
  return hp.length === 0
    ? { kind: "before_first_heading" }
    : { kind: "heading_path", heading_path: hp };
}

// ─── CRDT Remote Session Model ──────────────────────────────────────

/** Applied server role for a connected CRDT participant. */
export type ClientRole = "observer" | "editor";

/** Per-tab runtime identity for a CRDT participant. Never use writerId for this. */
export type ClientInstanceId = string;

/** Desired runtime mode requested by a tab-local controller. */
export type RequestedMode = "none" | "observer" | "editor";

/** Attachment state of a participant relative to a live DocSession. */
export type AttachmentState = "detached" | "waiting_for_session" | "attached_to_session";

/** Explicit identity of one live backend DocSession. */
export type DocSessionId = string;

/** Explicit focus target for the one section currently edited by this tab. */
export type EditorFocusTarget = SectionTarget;

/** Server-authoritative runtime state for one connected CRDT participant/tab. */
export interface RemoteParticipant {
  clientInstanceId: ClientInstanceId;
  writerId: string;
  docPath: DocPath;
  clientRole: ClientRole;
  requestedMode: RequestedMode;
  attachmentState: AttachmentState;
  docSessionId: DocSessionId | null;
  editorFocusTarget: EditorFocusTarget | null;
}

/** Frontend request to transition this tab into a new CRDT mode. */
export interface ModeTransitionRequest {
  requestId: string;
  clientInstanceId: ClientInstanceId;
  docPath: DocPath;
  requestedMode: RequestedMode;
  editorFocusTarget: EditorFocusTarget | null;
}

/** Successful server application of a mode transition request. */
export interface ModeTransitionResultSuccess {
  kind: "success";
  requestId: string;
  clientInstanceId: ClientInstanceId;
  requestedMode: RequestedMode;
  attachmentState: AttachmentState;
  docSessionId: DocSessionId | null;
  clientRole: ClientRole | null;
}

/** Rejected (impossible or stale) server result for a transition request. */
export interface ModeTransitionResultRejected {
  kind: "rejected";
  requestId: string;
  clientInstanceId: ClientInstanceId;
  requestedMode: RequestedMode;
  attachmentState: AttachmentState;
  docSessionId: DocSessionId | null;
  clientRole: ClientRole | null;
  reason: string;
}

export type ModeTransitionResult = ModeTransitionResultSuccess | ModeTransitionResultRejected;

/** Single source of truth for one tab's CRDT controller runtime state. */
export interface DocumentSessionControllerState {
  clientInstanceId: ClientInstanceId;
  requestedMode: RequestedMode;
  clientRole: ClientRole | null;
  attachmentState: AttachmentState;
  docSessionId: DocSessionId | null;
  editorFocusTarget: EditorFocusTarget | null;
  pendingTransition: ModeTransitionRequest | null;
}

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

// ─── Section Score Snapshot ────────────────────────────────────────

/** Keyed by section key → score at the time of evaluation/commit. */
export type SectionScoreSnapshot = Record<string, number>;

// ─── Human-Involvement Presets ───────────────────────────────────

export type HumanInvolvementPresetName = "yolo" | "aggressive" | "eager" | "conservative";

export interface HumanInvolvementPreset {
  name: HumanInvolvementPresetName;
  midpoint_seconds: number;
  steepness: number;
  description: string;
}

export const HUMAN_INVOLVEMENT_PRESETS: Record<HumanInvolvementPresetName, HumanInvolvementPreset> = {
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

export type GovernanceMode = "available" | "forced";

export type AgentAuthPolicy = "open" | "register" | "verify";

export interface AdminConfig {
  humanInvolvement_preset: HumanInvolvementPresetName;
  humanInvolvement_midpoint_seconds: number;
  humanInvolvement_steepness: number;
  snapshot_enabled: boolean;
  governance_mode: GovernanceMode;
  agent_auth_policy: AgentAuthPolicy;
}

// ─── Proposal Model (v4 — layered storage / domain / DTO) ─────────

export type ProposalStatus = "draft" | "pending" | "inprogress" | "committing" | "committed" | "withdrawn";

// ── Storage layer (what is stored in meta.json on disk) ────────────

/** Base fields present in every proposal meta.json file regardless of lifecycle state. */
export interface ProposalFileBase {
  id: ProposalId;
  writer: WriterIdentity;
  intent: string;
  sections: ProposalSection[];
  created_at: string;
}

/** Committed proposal meta.json — adds terminal commit fields (both required). */
export interface CommittedProposalFile extends ProposalFileBase {
  committed_head: string;
  humanInvolvement_at_commit: Record<string, number>;
}

/** In-progress proposal meta.json — adds lock metadata from draft→inprogress transition. */
export interface InProgressProposalFile extends ProposalFileBase {
  locked_sections: ProposalSection[];
  locked_at: string;
}

/** Withdrawn proposal meta.json — adds optional withdrawal reason. */
export interface WithdrawnProposalFile extends ProposalFileBase {
  withdrawal_reason?: string;
}

/** Union of all proposal file variants for untyped disk reads. */
export type AnyProposalFile = ProposalFileBase | InProgressProposalFile | CommittedProposalFile | WithdrawnProposalFile;

// ── Domain layer (file + status, runtime representation) ──────────

/** Draft, pending, or committing proposal (no terminal fields). */
export interface DraftProposal extends ProposalFileBase {
  status: "draft" | "pending" | "committing";
}

/** In-progress proposal — locks acquired, human can edit before committing. */
export interface InProgressProposal extends InProgressProposalFile {
  status: "inprogress";
}

/** Committed proposal with required terminal fields. */
export interface CommittedProposalDomain extends CommittedProposalFile {
  status: "committed";
}

/** Withdrawn proposal with optional reason. */
export interface WithdrawnProposalDomain extends WithdrawnProposalFile {
  status: "withdrawn";
}

/** Discriminated union of all proposal domain states. */
export type AnyProposal = DraftProposal | InProgressProposal | CommittedProposalDomain | WithdrawnProposalDomain;

// ── DTO layer (enriched for API responses) ────────────────────────

/** Draft proposal DTO — adds required human-involvement evaluation computed at read time. */
export interface DraftProposalDTO extends DraftProposal {
  humanInvolvement_evaluation: ProposalHumanInvolvementEvaluation;
  sections: EvaluatedSection[];
}

/** In-progress proposal DTO — adds evaluation computed at read time. */
export interface InProgressProposalDTO extends InProgressProposal {
  humanInvolvement_evaluation: ProposalHumanInvolvementEvaluation;
  sections: EvaluatedSection[];
}

/** Union of all proposal DTO variants for API responses. */
export type ProposalDTO = DraftProposalDTO | InProgressProposalDTO | CommittedProposalDomain | WithdrawnProposalDomain;


// ── Proposal sub-types ────────────────────────────────────────────

export interface ProposalSection {
  doc_path: string;
  heading_path: string[];
  justification?: string;
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
}

// ─── Section State / Activity ──────────────────────────────────────

export interface SectionState {
  doc_path: string;
  heading_path: string[];
  last_human_commit_sha: string | null;
  last_editor_id: string | null;
  last_editor_type: AttributionWriterType | null;
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
  preset: HumanInvolvementPresetName;
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
    last_editor?: { id: string; name: string; timestampMs: number; type: AttributionWriterType; seconds_ago: number };
    /** True when a human proposal (draft or inprogress) locks this section. */
    blocked?: boolean;
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

export interface CommitProposalAccepted {
  proposal_id: ProposalId;
  status: "committed";
  outcome: "accepted";
  committed_head: string;
  evaluation: ProposalHumanInvolvementEvaluation;
  sections: EvaluatedSection[];
}

export interface CommitProposalBlocked {
  proposal_id: ProposalId;
  status: "draft";
  outcome: "blocked";
  evaluation: ProposalHumanInvolvementEvaluation;
  sections: EvaluatedSection[];
}

export type CommitProposalResponse = CommitProposalAccepted | CommitProposalBlocked;

export interface WithdrawProposalResponse {
  proposal_id: ProposalId;
  status: "withdrawn";
}

export interface AcquireLocksSuccess {
  proposal_id: ProposalId;
  acquired: true;
  status: "inprogress";
}

export interface AcquireLocksFailure {
  proposal_id: ProposalId;
  acquired: false;
  reason: string;
  section?: SectionTargetRef;
}

export type AcquireLocksResponse = AcquireLocksSuccess | AcquireLocksFailure;

export interface ReadProposalResponse {
  proposal: ProposalDTO;
}

export interface ListProposalsResponse {
  proposals: AnyProposal[];
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

export interface ActivityItem {
  id: string;
  timestamp: string;
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

export interface ServerStartRecord {
  type: "server_start";
  timestamp: number;
}

export interface SnapshotRecord {
  type: "snapshot";
  timestamp: number;
  batch_doc_count: number;
  failed_doc_count: number;
  content_file_count: number;
  snapshot_file_count: number;
  error?: string;
}

export type SnapshotRunRecord = ServerStartRecord | SnapshotRecord;

export interface GetAdminSnapshotHistoryResponse {
  snapshot_enabled: boolean;
  current_content_file_count: number;
  current_snapshot_file_count: number;
  commits_since_last_snapshot: number | null;
  history: SnapshotRunRecord[];
}

// ─── Create Document ───────────────────────────────────────────

export interface CreateDocumentResponse {
  doc_path: string;
}

// ─── Auth ──────────────────────────────────────────────────────────

export type LoginProvider = "single_user" | "credentials" | "oidc" | "hybrid";

export interface AuthMethod {
  type: "single_user" | "credentials" | "oidc";
  displayName: string;
  authUrl?: string; // only present for "oidc"
}

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
  writer_id: string;
  writer_display_name: string;
  writer_type: WriterType;
  /** All writer IDs who contributed edits during this session. Used by frontends
   *  to clear dirty/persistence state for all participants, not just the committer. */
  contributor_ids: string[];
  seconds_ago: number;
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
  writer_type: WriterType;
  doc_path: string;
  heading_path: string[];
}

export interface PresenceDoneEvent {
  type: "presence:done";
  writer_id: string;
  writer_display_name: string;
  writer_type: WriterType;
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

export interface ProposalDraftEvent {
  type: "proposal:draft";
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

export interface CatalogChangedEvent {
  type: "catalog:changed";
  added_doc_paths?: string[];
  removed_doc_paths?: string[];
  writer_type?: WriterType;
  writer_display_name?: string;
}

export interface ProposalInjectedIntoSessionEvent {
  type: "proposal:injected_into_session";
  doc_path: string;
  proposal_id: string;
  writer_display_name: string;
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
  | ProposalDraftEvent
  | ProposalWithdrawnEvent
  | CatalogChangedEvent
  | ProposalInjectedIntoSessionEvent;

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

// ─── Agent Activity View ─────────────────────────────────────────

export type AgentConnectionStatus = "active" | "idle" | "offline";

export interface AgentProposalSnapshot {
  readonly id: string;
  readonly intent: string;
  readonly status: ProposalStatus;
  readonly created_at: string;
  readonly doc_paths: readonly string[];
  readonly section_count: number;
}

export interface AgentActivitySummary {
  readonly agent_id: string;
  readonly display_name: string;
  readonly connection_status: AgentConnectionStatus;
  readonly last_seen_at: string | null;
  readonly mcp_tool_usage: Readonly<Record<string, number>>;
  readonly draft_proposals: readonly AgentProposalSnapshot[];
  readonly recent_proposals: readonly AgentProposalSnapshot[];
  readonly stats: {
    readonly proposals_committed: number;
    readonly proposals_blocked: number;
    readonly proposals_withdrawn: number;
    readonly total_tool_calls: number;
  };
}

export interface GetAgentsFullSummaryResponse {
  readonly agents: readonly AgentActivitySummary[];
  readonly posture: {
    readonly preset: HumanInvolvementPresetName;
    readonly description: string;
  };
}

// ─── Git Blame Attribution ────────────────────────────────────────

export interface BlameLineAttribution {
  line: number;
  type: AttributionWriterType | "mixed";
  author?: string;
}

export interface BlameResponse {
  lines: BlameLineAttribution[];
}

// ─── Restore Notification ─────────────────────────────────────────

export interface RestoreNotificationPayload {
  /** 7-char short SHA of the restore commit. */
  restored_sha: string;
  restored_by_display_name: string;
  /** SHA of the pre-emptive commit made before restore; null if the client had no dirty state. */
  pre_commit_sha: string | null;
  /** Heading paths this writer had dirty; null if not an affected writer. */
  your_dirty_heading_paths: string[][] | null;
}
