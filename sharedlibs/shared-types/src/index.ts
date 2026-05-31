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

/**
 * Explicit focus target for the one section currently edited by this tab.
 * Part of the LIVE, server-authoritative CRDT mode-transition surface
 * (`RemoteParticipant` / `ModeTransitionRequest` / `DocumentSessionControllerState`),
 * which the CRDT coordinator patches per participant. Kept (MW-13); this is NOT
 * the removed JSON focus/pulse client-message surface.
 */
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

/**
 * ProposalTargetRef — identity of a thing a proposal targets, used by proposal
 * FSM lock shapes and agent-write-policy result shapes (spec 12 §Data Shapes).
 *
 * Aliased to {@link SectionTargetRef} for now (a `{ doc_path, heading_path }`
 * pair). TODO(Area Q open question): revisit if proposals must target
 * tombstones / whole documents wider than a single section ref, in which case
 * this should become a distinct discriminated type rather than an alias.
 */
export type ProposalTargetRef = SectionTargetRef;

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

/**
 * Keyed by section key → score at the time of commit. Retained ONLY as the
 * human-involvement-policy committed-metadata representation (aligns with
 * `CommittedProposalFile.humanInvolvement_at_commit`); not a generic app type.
 */
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
  /**
   * Owning DocSession identity for CRDT-materialized live-edit proposals
   * (Area B). Present only on proposals created lazily by a DocSession's
   * live-edit materialization; absent for human draft→inprogress and agent
   * proposals. Used to enforce one-active-`inprogress`-proposal-per-DocSession
   * (Invariant 7) and to look the proposal up by session identity. NOTE: the
   * derived `status` is still never stored.
   */
  docSessionId?: DocSessionId;
}

/** Committed proposal meta.json — adds terminal commit fields (both required). */
export interface CommittedProposalFile extends ProposalFileBase {
  committed_head: string;
  /**
   * Policy-specific committed metadata for the human-involvement compatibility
   * policy. Preserved as-is (spec 12 §Data Shapes `HumanInvolvementCommittedProposalMetadata`);
   * do NOT generalise into a generic `commitRecord`. See {@link HumanInvolvementCommittedProposalMetadata}.
   */
  humanInvolvement_at_commit: Record<string, number>;
}

/**
 * Spec-12-aligned naming alias for the human-involvement compatibility policy's
 * committed metadata. Identical shape to `CommittedProposalFile.humanInvolvement_at_commit`.
 * A posture/delegation committed-metadata type is intentionally NOT added yet
 * (spec defers a generic audit format).
 */
export type HumanInvolvementCommittedProposalMetadata = Record<string, number>;

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

/**
 * Draft proposal DTO — adds agent-write-policy + proposal-lock evaluation
 * computed at read time. `sections` reverts to plain {@link ProposalSection}[]
 * (per-section policy summaries are surfaced via the write-policy targets, not
 * baked into the section type). Lock conflicts are surfaced separately from
 * `agentWritePolicy` per spec 12 §Event/API Surfaces.
 */
export interface DraftProposalDTO extends DraftProposal {
  agentWritePolicy?: HumanInvolvementPolicyResult;
  lockEvaluation?: ProposalLockResult;
}

/** In-progress proposal DTO — adds agent-write-policy + proposal-lock evaluation computed at read time. */
export interface InProgressProposalDTO extends InProgressProposal {
  agentWritePolicy?: HumanInvolvementPolicyResult;
  lockEvaluation?: ProposalLockResult;
}

/** Union of all proposal DTO variants for API responses. */
export type ProposalDTO = DraftProposalDTO | InProgressProposalDTO | CommittedProposalDomain | WithdrawnProposalDomain;


// ── Proposal sub-types ────────────────────────────────────────────

export interface ProposalSection {
  doc_path: string;
  heading_path: string[];
  justification?: string;
}

// ─── Agent Write Policy (spec 12 §Data Shapes) ─────────────────────
//
// The agent-write-policy result is the app/frontend-readable contract that
// replaces the old generic `humanInvolvement_evaluation` / `EvaluatedSection`
// vocabulary. The core carries only `canWrite` (machine-branchable) plus a
// mandatory prose `message` (Area M: never return a bare reason code as the
// explanation) and a typed `details` payload that varies per concrete policy.
//
// Common app code MUST branch on `canWrite` only. It must NOT assume `details`
// contains a score, reason enum, posture, delay, delegation, or threshold —
// those live inside concrete per-policy detail types below.

/** One per-target entry of an agent-write-policy result. */
export interface AgentWritePolicyTarget<TTargetDetails> {
  target: ProposalTargetRef;
  canWrite: boolean;
  /** Prose explanation for this target's decision (Area M). */
  message: string;
  details: TTargetDetails;
}

/** Generic agent-write-policy result. `TPolicyDetails`/`TTargetDetails` are typed by the active policy. */
export interface AgentWritePolicyResult<TPolicyDetails, TTargetDetails> {
  canWrite: boolean;
  /** Prose explanation for the overall decision (Area M). */
  message: string;
  targets: AgentWritePolicyTarget<TTargetDetails>[];
  details: TPolicyDetails;
}

/**
 * Human-involvement-compatibility policy detail reason (spec 12 §Data Shapes).
 *
 * Reframed from the old `EvaluatedSectionBlockedReason` soft-block union: the
 * dirty-session / live-focus reasons (`active_live_edit`,
 * `uncommitted_live_edits`) are dropped because all edits now flow through
 * proposals (Area F). This is a human-involvement-policy DETAIL enum, not a
 * generic app code — never surface it as the human-facing explanation (Area M).
 */
export type HumanInvolvementBlockedReason = "human_proposal_lock" | "aggregate_impact";

/** Policy-level details for the human-involvement compatibility policy. */
export interface HumanInvolvementPolicyDetails {
  aggregateImpact: number;
  aggregateThreshold: number;
}

/** Per-target details for the human-involvement compatibility policy. */
export interface HumanInvolvementTargetDetails {
  score: number;
  blockedReason: HumanInvolvementBlockedReason | null;
  justification: string | null;
}

/** Convenience alias: an agent-write-policy result for the human-involvement compatibility policy. */
export type HumanInvolvementPolicyResult = AgentWritePolicyResult<
  HumanInvolvementPolicyDetails,
  HumanInvolvementTargetDetails
>;

// ─── Posture / Delegation Policy (spec 12, forward-compat) ─────────
// Defined concretely and separately from the human-involvement details — no
// shared vocabulary across policies.

export type DocumentPosture = "open" | "guarded" | "human_only";

/** Policy-level details for the posture/delegation policy (no shared fields). */
export type PostureDelegationPolicyDetails = Record<string, never>;

/** Per-target details for the posture/delegation policy. */
export interface PostureDelegationTargetDetails {
  posture: DocumentPosture;
  delegatedByUserId: string | null;
}

// ─── Proposal FSM Lock Results (spec 12 §Data Shapes) ──────────────
// Kept under lock/conflict naming, deliberately separate from agent write
// policy. Definitions only; the FSM transition behaviour is Area F.

export interface ProposalLockCheck {
  proposalId: ProposalId;
  targets: ProposalTargetRef[];
}

export interface ProposalLockConflict {
  target: ProposalTargetRef;
  blockingProposalId: ProposalId;
  blockingProposalStatus: ProposalStatus;
  blockingWriter: WriterIdentity;
  /** Required action-oriented prose explanation for this conflict (Area M owns wording). */
  message: string;
}

export interface ProposalLockResult {
  acquired: boolean;
  conflicts: ProposalLockConflict[];
  /** Required top-level prose explanation; empty/success-phrased when acquired (Area M owns wording). */
  message: string;
}

// ─── Section-level Agent-Write-Policy Summary (spec 12 §Event/API) ──
//
// Replaces the hardcoded `humanInvolvement_score: number` generic field on the
// read-API section shapes. The generic part is `canWrite`; a human-involvement
// compatibility policy may still render a `score` inside its own `humanInvolvement`
// details. The builder behaviour is Area L.

export interface SectionAgentWritePolicySummary {
  /** Whether agents can currently write to this section under the active policy. */
  canWrite: boolean;
  /**
   * Backend-authored prose explanation of the current write-policy state for
   * this section. The single source of truth for the human-readable line shown
   * in the governance gutter / heatmap — clients render this verbatim rather
   * than synthesizing it from `canWrite` (spec 12 §"render the policy's prose
   * messages — never bare reason codes or enums").
   */
  message: string;
  /** Human-involvement compatibility policy details (present when that policy is active). */
  humanInvolvement?: { score: number };
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
  agentWritePolicy: SectionAgentWritePolicySummary;
}

// ─── Heatmap ───────────────────────────────────────────────────────

export interface HeatmapEntry {
  doc_path: string;
  heading_path: string[];
  agentWritePolicy: SectionAgentWritePolicySummary;
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

export interface AllSessionStatusesResponse {
  live_session_count: number;
  outstanding_doc_count: number;
  oldest_outstanding_change_at: string | null;
  last_commit_at: string | null;
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
  agentWritePolicy: SectionAgentWritePolicySummary;
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
    agentWritePolicy: SectionAgentWritePolicySummary;
    crdt_session_active: boolean;
    section_length_warning: boolean;
    word_count: number;
    /** Opaque backend-owned CRDT fragment identity. */
    fragment_key: string;
    /** Section filename (e.g. "sec_abc123def.md"). Useful for UI metadata. */
    section_file: string;
    last_editor?: { id: string; name: string; timestampMs: number; type: AttributionWriterType; seconds_ago: number };
    /** True when a proposal FSM lock currently locks this section (lock/conflict naming, spec 12 §Event/API). */
    locked?: boolean;
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
  /** Machine-readable branching field only — NOT the human-facing explanation (Area M). */
  outcome: ProposalOutcome;
  agentWritePolicy: HumanInvolvementPolicyResult;
  lockEvaluation?: ProposalLockResult;
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
  agentWritePolicy: HumanInvolvementPolicyResult;
}

export interface CommitProposalBlocked {
  proposal_id: ProposalId;
  status: "draft";
  outcome: "blocked";
  /** Required prose explanation for the block (Area M). */
  message: string;
  agentWritePolicy: HumanInvolvementPolicyResult;
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
  /** Required prose explanation for the lock-acquisition failure (Area M). */
  message: string;
  /** Structured FSM lock conflicts that blocked acquisition (spec 12 §Data Shapes). */
  conflicts: ProposalLockConflict[];
}

export type AcquireLocksResponse = AcquireLocksSuccess | AcquireLocksFailure;

export interface ReadProposalResponse {
  proposal: ProposalDTO;
}

export interface ListProposalsResponse {
  proposals: AnyProposal[];
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
  snapshot_root: string;
  snapshot_root_writable: boolean;
  snapshot_root_error?: string;
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

export interface WriterDirtyStateChangedEvent {
  type: "writer:dirty-state-changed";
  writer_id: string;
  doc_path: string;
}

export interface SessionStatusChangedEvent {
  type: "session:status-changed";
  doc_path: string;
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

export interface ProposalInProgressEvent {
  type: "proposal:inprogress";
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

export interface ProposalSectionAvailabilityEntry {
  doc_path: string;
  heading_path: string[];
  available: boolean;
  /**
   * Required action-oriented prose explanation when `available` is false (Area M:
   * never a bare enum code). Describes which proposal/writer holds the section and
   * what clears it. Omitted when the section is available.
   */
  message?: string;
  /** Structured FSM-lock conflict fields for branching/styling only (spec 12 §Event/API). */
  blocking_proposal_id?: string;
  blocking_proposal_status?: ProposalStatus;
  holder_writer_id?: string;
  holder_writer_display_name?: string;
}

export interface ProposalSectionAvailabilityEvent {
  type: "proposal:section-availability";
  proposal_id: string;
  proposal_status: ProposalStatus;
  sections: ProposalSectionAvailabilityEntry[];
}

export interface CatalogChangedEvent {
  type: "catalog:changed";
  added_doc_paths?: string[];
  removed_doc_paths?: string[];
  writer_type?: WriterType;
  writer_display_name?: string;
}

/**
 * Per-section CRDT block-state events (spec 05-ydoc-lifecycle §"Section
 * block-state events"). These ride the JSON application WebSocket and keep the
 * browser's mount Set in lockstep with server reality:
 *   section:blocked   — a proposal lock now owns the section → read-only
 *   section:unblocked — the section returns to editable
 *   section:gone      — the section's canonical identifier no longer resolves
 * `fragment_key` is the opaque backend-owned CRDT fragment identity.
 */
export interface SectionBlockStateEvent {
  type: "section:blocked" | "section:unblocked" | "section:gone";
  doc_path: string;
  fragment_key: string;
  heading_path?: string[];
}

export type WsServerEvent =
  | ContentCommittedEvent
  | DirtyChangedEvent
  | WriterDirtyStateChangedEvent
  | SessionStatusChangedEvent
  | AgentReadingEvent
  | PresenceEditingEvent
  | PresenceDoneEvent
  | DocStructureChangedEvent
  | DocRenamedEvent
  | ProposalDraftEvent
  | ProposalInProgressEvent
  | ProposalWithdrawnEvent
  | ProposalSectionAvailabilityEvent
  | SectionBlockStateEvent
  | CatalogChangedEvent;

// ─── WebSocket Client Messages ─────────────────────────────────────
//
// The JSON application WebSocket only carries subscription intent. The former
// focus/pulse client-message surface (`focus_section`/`blur_section`/
// `session_departure`) had NO server consumer — the hub parser ignored them
// entirely (spec 06 §6) — so it was removed end-to-end (MW-13).
//
// NOTE: this is distinct from the LIVE CRDT mode-transition focus surface
// (`EditorFocusTarget` / `RemoteParticipant.editorFocusTarget` /
// `ModeTransitionRequest.editorFocusTarget` above), which IS server-authoritative
// (the CRDT coordinator patches `editorFocusTarget`) and is deliberately kept.

export interface WsSubscribeMessage {
  action: "subscribe";
  doc_path: string;
}

export interface WsUnsubscribeMessage {
  action: "unsubscribe";
  doc_path: string;
}

export type WsClientMessage =
  | WsSubscribeMessage
  | WsUnsubscribeMessage;

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

// ─── Document Replacement Notice ─────────────────────────────────

export interface DocumentReplacementNoticePayload {
  /** Simple reconnect notice shown after restore or overwrite replaced the document. */
  message: string;
}
