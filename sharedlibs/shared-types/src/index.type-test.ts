/**
 * Compile-only type-assertion smoke test for the Area Q shared types.
 *
 * This file contains NO runtime behaviour. It exists purely so that `tsc`
 * exercises the new agent-write-policy generics, proposal FSM lock shapes, and
 * the retyped DTO / read-API surfaces. If any of these stop type-checking, the
 * shared-types build fails. It is included by `tsconfig.json` (`include: src`).
 */

import type {
  AgentWritePolicyResult,
  AgentWritePolicyTarget,
  HumanInvolvementPolicyDetails,
  HumanInvolvementTargetDetails,
  HumanInvolvementPolicyResult,
  HumanInvolvementBlockedReason,
  DocumentPosture,
  PostureDelegationPolicyDetails,
  PostureDelegationTargetDetails,
  ProposalTargetRef,
  ProposalLockCheck,
  ProposalLockConflict,
  ProposalLockResult,
  DraftProposalDTO,
  InProgressProposalDTO,
  CreateProposalResponse,
  CommitProposalAccepted,
  CommitProposalBlocked,
  AcquireLocksFailure,
  SectionAgentWritePolicySummary,
  SectionState,
  HeatmapEntry,
  SectionMeta,
  GetDocumentSectionsResponse,
  HumanInvolvementCommittedProposalMetadata,
} from "./index.js";

// ── Shared sample target ──────────────────────────────────────────
const target: ProposalTargetRef = { doc_path: "doc.md", heading_path: ["A", "B"] };

// ── Agent write policy: human-involvement compatibility instantiation ──
const hiTargetDetails: HumanInvolvementTargetDetails = {
  score: 0.42,
  blockedReason: "aggregate_impact",
  justification: null,
};

const hiBlockedReasons: HumanInvolvementBlockedReason[] = ["human_proposal_lock", "aggregate_impact"];

const hiPolicyDetails: HumanInvolvementPolicyDetails = {
  aggregateImpact: 1.2,
  aggregateThreshold: 1.0,
};

const hiTarget: AgentWritePolicyTarget<HumanInvolvementTargetDetails> = {
  target,
  canWrite: false,
  message: "Blocked: aggregate impact exceeds threshold.",
  details: hiTargetDetails,
};

const hiResult: HumanInvolvementPolicyResult = {
  canWrite: false,
  message: "One or more targets are blocked by human involvement.",
  targets: [hiTarget],
  details: hiPolicyDetails,
};

// The convenience alias must be assignable to/from the explicit generic form.
const hiResultExplicit: AgentWritePolicyResult<HumanInvolvementPolicyDetails, HumanInvolvementTargetDetails> = hiResult;

// ── Agent write policy: posture/delegation instantiation ──────────
const postures: DocumentPosture[] = ["open", "guarded", "human_only"];

const postureTargetDetails: PostureDelegationTargetDetails = {
  posture: "guarded",
  delegatedByUserId: "user-123",
};

const posturePolicyDetails: PostureDelegationPolicyDetails = {};

const postureResult: AgentWritePolicyResult<
  PostureDelegationPolicyDetails,
  PostureDelegationTargetDetails
> = {
  canWrite: true,
  message: "Delegated write permitted.",
  targets: [
    { target, canWrite: true, message: "Delegated by user-123.", details: postureTargetDetails },
  ],
  details: posturePolicyDetails,
};

// ── Proposal FSM lock results ─────────────────────────────────────
const lockCheck: ProposalLockCheck = { proposalId: "p1", targets: [target] };

const lockConflict: ProposalLockConflict = {
  target,
  blockingProposalId: "p2",
  blockingProposalStatus: "inprogress",
  blockingWriter: { id: "u1", type: "human", displayName: "Alice" },
  message: "Locked by Alice's inprogress proposal.",
};

const lockResult: ProposalLockResult = {
  acquired: false,
  conflicts: [lockConflict],
  message: "1 targeted section is locked by another proposal.",
};

// ── Retyped DTOs ──────────────────────────────────────────────────
const draftDto: DraftProposalDTO = {
  id: "p1",
  status: "draft",
  writer: { id: "u1", type: "human", displayName: "Alice" },
  intent: "edit",
  sections: [{ doc_path: "doc.md", heading_path: ["A"] }],
  created_at: "2026-01-01T00:00:00Z",
  agentWritePolicy: hiResult,
  lockEvaluation: lockResult,
};

const inProgressDto: InProgressProposalDTO = {
  id: "p1",
  status: "inprogress",
  writer: { id: "u1", type: "human", displayName: "Alice" },
  intent: "edit",
  sections: [{ doc_path: "doc.md", heading_path: ["A"] }],
  created_at: "2026-01-01T00:00:00Z",
  locked_sections: [{ doc_path: "doc.md", heading_path: ["A"] }],
  locked_at: "2026-01-01T00:00:00Z",
  agentWritePolicy: hiResult,
};

// ── Retyped responses (required prose `message` on blocked shapes) ──
const createResp: CreateProposalResponse = {
  proposal_id: "p1",
  status: "draft",
  outcome: "accepted",
  agentWritePolicy: hiResult,
};

const commitAccepted: CommitProposalAccepted = {
  proposal_id: "p1",
  status: "committed",
  outcome: "accepted",
  committed_head: "abc123",
  agentWritePolicy: hiResult,
};

const commitBlocked: CommitProposalBlocked = {
  proposal_id: "p1",
  status: "draft",
  outcome: "blocked",
  message: "Cannot commit: section blocked by human involvement.",
  agentWritePolicy: hiResult,
};
// `message` is required — this read must be of type `string`.
const blockedMessage: string = commitBlocked.message;

const acquireFailure: AcquireLocksFailure = {
  proposal_id: "p1",
  acquired: false,
  message: "Lock acquisition failed: conflicting proposal.",
  conflicts: [lockConflict],
};

// ── Retyped read-API section summaries ────────────────────────────
const sectionSummary: SectionAgentWritePolicySummary = {
  canWrite: true,
  message: "Agents can currently write to this section.",
  humanInvolvement: { score: 0.1 },
};

const sectionState: SectionState = {
  doc_path: "doc.md",
  heading_path: ["A"],
  last_human_commit_sha: null,
  last_editor_id: null,
  last_editor_type: null,
  last_editor_display_name: null,
  crdt_session_active: false,
  crdt_holder_count: 0,
  diverged: false,
  base_head: null,
  agentWritePolicy: sectionSummary,
};

const heatmapEntry: HeatmapEntry = {
  doc_path: "doc.md",
  heading_path: ["A"],
  agentWritePolicy: { canWrite: false, message: "Agents blocked here." },
  crdt_session_active: false,
  last_human_commit_sha: null,
  last_commit_author: null,
  last_commit_timestamp: null,
};

const sectionMeta: SectionMeta = {
  heading_path: ["A"],
  agentWritePolicy: sectionSummary,
  crdt_session_active: false,
  section_length_warning: false,
  word_count: 10,
};

const docSections: GetDocumentSectionsResponse = {
  doc_path: "doc.md",
  sections: [
    {
      heading: "A",
      heading_path: ["A"],
      depth: 1,
      content: "body",
      agentWritePolicy: sectionSummary,
      crdt_session_active: false,
      section_length_warning: false,
      word_count: 1,
      fragment_key: "frag",
      section_file: "sec_abc.md",
      locked: false,
    },
  ],
};

const committedMeta: HumanInvolvementCommittedProposalMetadata = { "doc.md::A": 0.5 };

// Reference everything so noUnusedLocals (if enabled) stays satisfied.
export const __areaQTypeTestRefs = {
  hiResultExplicit,
  hiBlockedReasons,
  postures,
  postureResult,
  lockCheck,
  draftDto,
  inProgressDto,
  createResp,
  commitAccepted,
  commitBlocked,
  blockedMessage,
  acquireFailure,
  sectionState,
  heatmapEntry,
  sectionMeta,
  docSections,
  committedMeta,
};
