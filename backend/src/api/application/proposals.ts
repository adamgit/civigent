import type {
  CreateProposalRequest,
  UpdateProposalManifestRequest,
  ReplaceProposalSectionsRequest,
  WriteProposalDocumentSectionsRequest,
  ProposalDTO,
  ProposalStatus,
  HumanInvolvementPolicyResult,
  WriterIdentity,
} from "../../types/shared.js";
import { sectionTargetsOf } from "../../types/shared.js";
import {
  createProposal,
  readProposal,
  readProposalWithContent,
  listAllProposals,
  listDraftProposals,
  listPendingProposals,
  listInProgressProposals,
  listCommittingProposals,
  listCommittedProposals,
  listWithdrawnProposals,
  listDegradedProposals,
  findDraftProposalByWriter,
  declareReservedProposalSectionsFromRequest,
  transitionToWithdrawn,
  transitionToInProgress,
  isProposalMutable,
  isProposalStatus,
  ProposalNotFoundError,
  InvalidProposalStateError,
  ProposalIntegrityError,
} from "../../storage/proposal-repository.js";
import { evaluateAgentWritePolicy, commitProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { applyCommittedCanonicalToLiveSession } from "../../ws/crdt-ws-coordinator.js";
import { AgentWritePolicy, humanBypassPolicyResult } from "../../domain/agent-write-policy.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
import { SectionRef } from "../../domain/section-ref.js";

export { ProposalNotFoundError, InvalidProposalStateError, isProposalStatus };

export type ProposalWriter = Pick<WriterIdentity, "id" | "type" | "displayName" | "email">;

export async function listProposalsForStatusFilter(status?: ProposalStatus) {
  if (!status) return listAllProposals();
  switch (status) {
    case "draft":
      return listDraftProposals();
    case "pending":
      return listPendingProposals();
    case "inprogress":
      return listInProgressProposals();
    case "committing":
      return listCommittingProposals();
    case "committed":
      return listCommittedProposals();
    case "withdrawn":
      return listWithdrawnProposals();
  }
  return listAllProposals();
}

export async function listMyProposals(writerId: string, status?: ProposalStatus) {
  const all = await listProposalsForStatusFilter(status);
  return all.filter((p) => p.writer.id === writerId);
}

/** The degraded (quarantined) proposals an admin must tend to — scans only the
 *  degradable statuses, never the full committed/withdrawn history. */
export async function listDegradedProposalsUseCase() {
  return listDegradedProposals();
}

// ─── Create ─────────────────────────────────────────────

export type CreateProposalValidation =
  | { ok: false; status: number; message: string }
  | { ok: true };

/** Validate an agent create-proposal request. Humans may start with empty sections. */
export function validateCreateProposal(writerType: "human" | "agent", body: CreateProposalRequest): CreateProposalValidation {
  const intent = typeof body.intent === "string" ? body.intent : "";
  if (writerType === "agent") {
    if (intent.trim().length === 0) {
      return { ok: false, status: 400, message: "intent is required." };
    }
    if (!Array.isArray(body.sections)) {
      return { ok: false, status: 400, message: "sections[] is required for agent proposals." };
    }
    for (const section of body.sections) {
      if (!section.doc_path || !Array.isArray(section.heading_path) || typeof section.content !== "string") {
        return { ok: false, status: 400, message: "Each section must have doc_path, heading_path, and content." };
      }
    }
  }
  return { ok: true };
}

export interface CreateProposalOutcome {
  proposalId: string;
  intent: string;
  /** Sections (without content) for event emission. */
  draftSections: Array<{ doc_path: string; heading_path: string[] }>;
  /** null for human (bypass); policy result for agents. */
  agentWritePolicy: HumanInvolvementPolicyResult;
  outcome: "accepted" | "blocked";
}

export async function createProposalUseCase(
  writer: ProposalWriter,
  body: CreateProposalRequest,
  replaceFlag: boolean,
): Promise<CreateProposalOutcome> {
  const intent = typeof body.intent === "string" ? body.intent : "";

  // replace=true auto-withdraws the most recent existing draft for convenience.
  if (replaceFlag) {
    const existing = await findDraftProposalByWriter(writer.id);
    if (existing) {
      await transitionToWithdrawn(existing.id, "auto-withdrawn by replace flag");
    }
  }

  const sections = (body.sections ?? []).map((s) => ({
    doc_path: s.doc_path,
    heading_path: s.heading_path,
    justification: s.justification,
  }));

  const sectionContents = (body.sections ?? []).map((s) => ({
    doc_path: s.doc_path,
    heading_path: s.heading_path,
    content: s.content,
  }));

  const { id: proposalId } = await createProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
    sections,
  );

  if (sectionContents.length > 0) {
    const editor = ProposalEditor.open(proposalId, "draft");
    for (const sc of sectionContents) {
      const heading = sc.heading_path.length === 0 ? "" : sc.heading_path[sc.heading_path.length - 1]!;
      await editor.writeSection(sc.doc_path, sc.heading_path, heading, sectionWriteInputFromExternal(sc.content));
    }
  }

  // Human reservations bypass Agent Write Policy entirely (spec 12).
  if (writer.type === "human") {
    return {
      proposalId,
      intent,
      draftSections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
      agentWritePolicy: humanBypassPolicyResult(),
      outcome: "accepted",
    };
  }

  // Agent proposals: evaluate the selected Agent Write Policy (informational —
  // the agent must commit explicitly).
  const agentWritePolicy = await evaluateAgentWritePolicy(proposalId);
  return {
    proposalId,
    intent,
    draftSections: sectionTargetsOf(agentWritePolicy.targets.map((t) => t.target)),
    agentWritePolicy,
    outcome: agentWritePolicy.canWrite ? "accepted" : "blocked",
  };
}

// ─── Read (metadata + content) ──────────────────────────

export async function readProposalDto(id: string): Promise<ProposalDTO> {
  const { proposal, sectionContent } = await readProposalWithContent(id);

  // `readProposalWithContent` now throws `ProposalIntegrityError` for any claimed
  // section whose body is missing, so every claimed section resolves here — no
  // `?? null` coercion that would hide a missing/corrupt body (claim-review 04).
  const sectionsWithContent = proposal.sections.map((s) => {
    const key = SectionRef.fromTarget(s).globalKey;
    const content = sectionContent.get(key);
    if (content === undefined) {
      // Unreachable in practice (the reader threw upstream); assert rather than coerce.
      throw new ProposalIntegrityError(proposal.id, key);
    }
    return { ...s, content };
  });

  let dto: ProposalDTO;
  if (proposal.status === "committed" || proposal.status === "withdrawn") {
    dto = { ...proposal, sections: sectionsWithContent };
  } else if (proposal.writer.type === "human") {
    dto = { ...proposal, sections: sectionsWithContent };
  } else {
    const agentWritePolicy = await evaluateAgentWritePolicy(proposal.id);
    dto = { ...proposal, agentWritePolicy, sections: sectionsWithContent };
  }
  return dto;
}

// ─── Modify ─────────────────────────────────────────────

type AnyProposalResult = import("../../storage/proposal-repository.js").UpdateProposalResult["proposal"];

export type ModifyProposalResult =
  | { ok: false; status: number; message: string }
  | {
      ok: true;
      updated: AnyProposalResult | (AnyProposalResult & { agentWritePolicy: HumanInvolvementPolicyResult });
      removedSections: Array<{ doc_path: string; heading_path: string[] }>;
      eventStatus: "inprogress" | "draft";
      eventSections: Array<{ doc_path: string; heading_path: string[] }>;
      intent: string;
      isHuman: boolean;
    };

export async function modifyProposalUseCase(
  proposalId: string,
  writer: ProposalWriter,
  body: UpdateProposalManifestRequest,
): Promise<ModifyProposalResult> {
  const proposal = await readProposal(proposalId);
  if (proposal.writer.id !== writer.id) {
    return { ok: false, status: 403, message: "You can only modify your own proposals." };
  }
  if (!isProposalMutable(proposal)) {
    return { ok: false, status: 409, message: `Cannot modify proposal in ${proposal.status} state.` };
  }
  if (!Array.isArray(body.targets)) {
    return { ok: false, status: 400, message: "targets[] is required." };
  }

  // Lock-boundary invariant: once a human proposal is inprogress, callers cannot
  // change the selected section scope. Section CONTENT is updated through the
  // dedicated staged-content routes, which leave the manifest scope untouched.
  if (proposal.status === "inprogress" && proposal.writer.type === "human") {
    const lockedSections = sectionTargetsOf(proposal.targets);
    const currentKeys = new Set(
      lockedSections.map((s) => new SectionRef(s.doc_path, s.heading_path).globalKey),
    );
    const requestedKeys = new Set(
      body.targets.map((s) => new SectionRef(s.doc_path, s.heading_path).globalKey),
    );
    const scopeChanged = currentKeys.size !== requestedKeys.size
      || [...requestedKeys].some((key) => !currentKeys.has(key));
    if (scopeChanged) {
      return {
        ok: false,
        status: 409,
        message: "Cannot change selected sections while proposal is inprogress. Exit lock-held state and re-acquire locks for a new scope.",
      };
    }
  }

  // Human/agent reservation: the section scope is the caller's explicit
  // declaration (the lock claim), not a structural-mutation-derived manifest, so
  // it uses the dedicated reservation declarator rather than the
  // `mutateProposalContent(...)` boundary (Claim 3 §Human reservations). This route
  // owns ONLY intent + scope; staged content is written through the staged-content
  // routes (`replaceProposalSectionsUseCase` / `writeProposalDocumentSectionsUseCase`).
  const { proposal: updated } = await declareReservedProposalSectionsFromRequest(
    proposal.id,
    body.targets.map((t) => ({
      doc_path: t.doc_path,
      heading_path: t.heading_path,
      justification: t.justification,
    })),
    body.intent,
  );

  const previousSections = proposal.sections;
  const updatedSections = updated.sections;
  const previousDocPaths = new Set(previousSections.map((section) => section.doc_path));
  const updatedDocPaths = new Set(updatedSections.map((section) => section.doc_path));
  const removedDocPaths = new Set(
    [...previousDocPaths].filter((docPath) => !updatedDocPaths.has(docPath)),
  );
  const removedSections = removedDocPaths.size === 0
    ? []
    : previousSections.filter((section) => removedDocPaths.has(section.doc_path));

  if (proposal.writer.type === "human") {
    return {
      ok: true,
      updated,
      removedSections: removedSections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
      eventStatus: updated.status === "inprogress" ? "inprogress" : "draft",
      eventSections: updatedSections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
      intent: updated.intent,
      isHuman: true,
    };
  }

  const agentWritePolicy = await evaluateAgentWritePolicy(proposal.id);
  return {
    ok: true,
    updated: { ...updated, agentWritePolicy },
    removedSections: removedSections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
    eventStatus: updated.status === "inprogress" ? "inprogress" : "draft",
    eventSections: updatedSections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
    intent: updated.intent,
    isHuman: false,
  };
}

// ─── Staged-content writes ──────────────────────────────
//
// Section CONTENT is written through ProposalEditor into the proposal content
// tree, separately from the manifest (intent + scope) owned by
// `modifyProposalUseCase`. These routes leave the manifest scope untouched.

export type StageProposalContentResult =
  | { ok: false; status: number; message: string }
  | {
      ok: true;
      proposal: AnyProposalResult | (AnyProposalResult & { agentWritePolicy: HumanInvolvementPolicyResult });
      isHuman: boolean;
    };

async function stageProposalSectionContent(
  proposalId: string,
  writer: ProposalWriter,
  sections: Array<{ doc_path: string; heading_path: string[]; content: string }>,
): Promise<StageProposalContentResult> {
  const proposal = await readProposal(proposalId);
  if (proposal.writer.id !== writer.id) {
    return { ok: false, status: 403, message: "You can only modify your own proposals." };
  }
  if (!isProposalMutable(proposal)) {
    return { ok: false, status: 409, message: `Cannot modify proposal in ${proposal.status} state.` };
  }

  const editor = ProposalEditor.open(proposal.id, proposal.status);
  for (const s of sections) {
    const heading = s.heading_path.length === 0 ? "" : s.heading_path[s.heading_path.length - 1]!;
    await editor.writeSection(s.doc_path, s.heading_path, heading, sectionWriteInputFromExternal(s.content));
  }

  // Re-read so the response reflects the proposal's current manifest state
  // (unchanged by content writes) consistently with the modify route's `updated`.
  const updated = await readProposal(proposal.id);
  if (proposal.writer.type === "human") {
    return { ok: true, proposal: updated, isHuman: true };
  }
  const agentWritePolicy = await evaluateAgentWritePolicy(proposal.id);
  return { ok: true, proposal: { ...updated, agentWritePolicy }, isHuman: false };
}

/**
 * Bulk staged-content replace across any number of target documents
 * (`PUT /api/proposals/:id/sections`). Routed through `ProposalEditor`.
 */
export async function replaceProposalSectionsUseCase(
  proposalId: string,
  writer: ProposalWriter,
  body: ReplaceProposalSectionsRequest,
): Promise<StageProposalContentResult> {
  if (!Array.isArray(body.sections)) {
    return { ok: false, status: 400, message: "sections[] is required." };
  }
  return stageProposalSectionContent(proposalId, writer, body.sections);
}

/**
 * Per-document staged-content write (`PUT /api/proposals/:id/documents/:docPath/sections`).
 * The document is supplied by the URL; each entry carries an in-document heading
 * path + content. Routed through `ProposalEditor`.
 */
export async function writeProposalDocumentSectionsUseCase(
  proposalId: string,
  writer: ProposalWriter,
  docPath: string,
  body: WriteProposalDocumentSectionsRequest,
): Promise<StageProposalContentResult> {
  if (!Array.isArray(body.sections)) {
    return { ok: false, status: 400, message: "sections[] is required." };
  }
  return stageProposalSectionContent(
    proposalId,
    writer,
    body.sections.map((s) => ({ doc_path: docPath, heading_path: s.heading_path, content: s.content })),
  );
}

// ─── Acquire locks (draft → inprogress) ─────────────────

export type AcquireLocksResult =
  | { kind: "error"; status: number; message: string }
  | { kind: "not_acquired"; proposalId: string; message: string; conflicts: import("../../storage/proposal-repository.js").LockAcquisitionResult["conflicts"] }
  | { kind: "acquired"; proposalId: string; acquiredProposal?: import("../../storage/proposal-repository.js").LockAcquisitionResult["proposal"] };

export async function acquireLocksUseCase(proposalId: string, writerId: string): Promise<AcquireLocksResult> {
  const proposal = await readProposal(proposalId);
  if (proposal.writer.id !== writerId) {
    return { kind: "error", status: 403, message: "You can only acquire locks on your own proposals." };
  }
  if (proposal.writer.type !== "human") {
    return { kind: "error", status: 409, message: "Only human proposals can acquire locks." };
  }
  if (proposal.status !== "draft") {
    return { kind: "error", status: 409, message: `Cannot acquire locks: proposal is in ${proposal.status} state, expected draft.` };
  }
  if (proposal.intent.trim().length === 0) {
    return { kind: "error", status: 409, message: "Cannot acquire locks: intent is required before entering inprogress." };
  }
  if (proposal.sections.length === 0) {
    return { kind: "error", status: 409, message: "Cannot acquire locks: select at least one section before entering inprogress." };
  }

  const result = await transitionToInProgress(proposalId);
  if (!result.acquired) {
    return { kind: "not_acquired", proposalId: proposal.id, message: result.message, conflicts: result.conflicts };
  }
  return { kind: "acquired", proposalId: proposal.id, acquiredProposal: result.proposal };
}

// ─── Commit ─────────────────────────────────────────────

export type CommitProposalResult =
  | { kind: "error"; status: number; message: string }
  | {
      kind: "committed";
      proposalId: string;
      committedHead: string;
      agentWritePolicy: HumanInvolvementPolicyResult;
      sections: Array<{ doc_path: string; heading_path: string[] }>;
      writerType: "human" | "agent";
    }
  | { kind: "blocked"; proposalId: string; agentWritePolicy: HumanInvolvementPolicyResult };

/**
 * The single application-level proposal commit path. Agent proposals branch on
 * AgentWritePolicy.canWrite; humans bypass it entirely (spec 12). `checkWrite`
 * is supplied by the HTTP layer (which owns auth) so this module stays
 * decoupled from request/response.
 */
export async function commitProposalUseCase(
  proposalId: string,
  writer: ProposalWriter,
  checkWrite: (docPath: string) => Promise<boolean>,
): Promise<CommitProposalResult> {
  const proposal = await readProposal(proposalId);
  if (proposal.writer.id !== writer.id) {
    return { kind: "error", status: 403, message: "You can only commit your own proposals." };
  }
  const committableStatuses = proposal.writer.type === "human" ? ["inprogress"] : ["draft"];
  if (!committableStatuses.includes(proposal.status)) {
    return { kind: "error", status: 409, message: `Cannot commit proposal in ${proposal.status} state.` };
  }
  if (proposal.writer.type === "human" && proposal.intent.trim().length === 0) {
    return { kind: "error", status: 409, message: "Cannot commit proposal with empty intent." };
  }

  const commitDocPaths = new Set(proposal.sections.map((s) => s.doc_path));
  for (const docPath of commitDocPaths) {
    const allowed = await checkWrite(docPath);
    if (!allowed) {
      return { kind: "error", status: 403, message: `You do not have permission to write to document "${docPath}".` };
    }
  }

  const sections = proposal.sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path }));

  // Human reservations always commit — humans bypass Agent Write Policy (spec 12).
  if (proposal.writer.type === "human") {
    const absorbResult = await commitProposalToCanonicalDetailed(proposal.id, {});
    await propagateCommitToLiveSessions(absorbResult, proposal.id);
    return {
      kind: "committed",
      proposalId: proposal.id,
      committedHead: absorbResult.commitSha,
      agentWritePolicy: humanBypassPolicyResult(),
      sections,
      writerType: "human",
    };
  }

  // Agent proposals: gate on the selected Agent Write Policy.
  const policyResult = await evaluateAgentWritePolicy(proposal.id);
  if (policyResult.canWrite) {
    const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);
    const absorbResult = await commitProposalToCanonicalDetailed(proposal.id, committedMetadata);
    await propagateCommitToLiveSessions(absorbResult, proposal.id);
    return {
      kind: "committed",
      proposalId: proposal.id,
      committedHead: absorbResult.commitSha,
      agentWritePolicy: policyResult,
      sections,
      writerType: "agent",
    };
  }
  return { kind: "blocked", proposalId: proposal.id, agentWritePolicy: policyResult };
}

/**
 * MW-3: after a proposal commits to canonical, push the committed section
 * changes into any OPEN live DocSession for the affected documents (canonical→
 * live, "one primitive, both directions"). Grouped by doc; the coordinator
 * skips a self-commit (the live session committing its own proposal).
 */
async function propagateCommitToLiveSessions(
  absorbResult: { changedSections: Array<{ docPath: string; headingPath: string[] }> },
  originProposalId: string,
): Promise<void> {
  const byDoc = new Map<string, string[][]>();
  for (const ref of absorbResult.changedSections) {
    if (!byDoc.has(ref.docPath)) byDoc.set(ref.docPath, []);
    byDoc.get(ref.docPath)!.push([...ref.headingPath]);
  }
  for (const [docPath, headingPaths] of byDoc) {
    await applyCommittedCanonicalToLiveSession(docPath, headingPaths, originProposalId);
  }
}

// ─── Cancel ─────────────────────────────────────────────

export type CancelProposalResult =
  | { kind: "error"; status: number; message: string }
  | { kind: "withdrawn"; proposalId: string; sections: Array<{ doc_path: string; heading_path: string[] }> };

export async function cancelProposalUseCase(proposalId: string, writerId: string, reason?: string): Promise<CancelProposalResult> {
  const proposal = await readProposal(proposalId);
  if (proposal.writer.id !== writerId) {
    return { kind: "error", status: 403, message: "You can only withdraw your own proposals." };
  }
  const withdrawn = await transitionToWithdrawn(proposal.id, reason);
  return {
    kind: "withdrawn",
    proposalId: withdrawn.id,
    sections: proposal.sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
  };
}
