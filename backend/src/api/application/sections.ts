import type {
  GetDocumentSectionsResponse,
  ReadSectionResponse,
  HumanInvolvementPolicyResult,
  WriterIdentity,
} from "../../types/shared.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";
import { ProposalEditor } from "../../storage/proposal-editor.js";
import {
  getDataRoot,
} from "../../storage/data-root.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { prependHeadings } from "../../storage/document-reader.js";
import { readSectionWithHeading, SectionNotFoundError } from "../../storage/section-reader.js";
import { HeadingNotFoundError } from "../../storage/heading-resolver.js";
import { InvalidDocPathError } from "../../storage/path-utils.js";
import { DocumentNotFoundError, DocumentAssemblyError } from "../../storage/document-reader.js";
import { ProposalNotFoundError } from "../../storage/proposal-repository.js";

export {
  SectionNotFoundError,
  HeadingNotFoundError,
  InvalidDocPathError,
  DocumentNotFoundError,
  DocumentAssemblyError,
  ProposalNotFoundError,
};
import {
  createTransientProposal,
  readProposal,
  updateProposalSections,
} from "../../storage/proposal-repository.js";
import { evaluateAgentWritePolicy, commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { AgentWritePolicy, humanBypassPolicyResult } from "../../domain/agent-write-policy.js";
import { ProposalFsmLockIndex } from "../../domain/proposal-fsm-lock-index.js";
import { BLOCKING_LOCK_STATUSES } from "../../domain/proposal-fsm-locks.js";
import { SectionRef } from "../../domain/section-ref.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import { buildSectionInvolvementMeta, broadcastAgentReading } from "../helpers/section-meta-builder.js";

export { broadcastAgentReading };

export type SectionWriter = Pick<WriterIdentity, "id" | "type" | "displayName" | "email">;

// ─── Single section read (GET /sections) ────────────────

export async function readSingleSection(docPath: string, headingPath: string[]): Promise<ReadSectionResponse> {
  const content = await readSectionWithHeading(docPath, headingPath);
  const headSha = await getHeadSha(getDataRoot());
  return { doc_path: docPath, heading_path: headingPath, content, head_sha: headSha };
}

// ─── Section list read (GET /documents/:docPath/sections) ──

export class SectionsReadForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionsReadForbiddenError";
  }
}

export interface ReadSectionListResult {
  response: GetDocumentSectionsResponse;
  headingPaths: string[][];
}

/**
 * Build the section-list response. When `proposalId` is supplied (the explicit
 * proposal-preview path), content comes from the writer's ProposalReader overlay
 * (writer ownership must be verified by the caller via `verifyProposalForRead`);
 * otherwise the default GET reads CANONICAL content only via `CanonicalReader`.
 * The default read no longer consults any session/live overlay (MW-7).
 */
export async function verifyProposalForRead(proposalId: string, writerId: string): Promise<void> {
  const proposal = await readProposal(proposalId);
  if (proposal.writer.id !== writerId) {
    throw new SectionsReadForbiddenError("You can only read sections using your own proposal_id.");
  }
}

export async function readSectionList(docPath: string, proposalId: string): Promise<ReadSectionListResult> {
  let sectionReader: {
    getSectionList: (docPath: string) => Promise<Array<{ heading: string; level: number; sectionFile: string; headingPath: string[] }>>;
    readAllSections: (docPath: string) => Promise<Map<string, import("../../storage/section-formatting.js").SectionBody>>;
  };
  if (proposalId.length > 0) {
    const proposal = await readProposal(proposalId);
    sectionReader = ProposalReader.open(proposal.id, proposal.status);
  } else {
    sectionReader = CanonicalReader.open();
  }

  const sectionList = await sectionReader.getSectionList(docPath);

  const headingPaths: string[][] = sectionList.map((s) => s.headingPath);
  const sectionFileByKey = new Map<string, string>(
    sectionList.map((s) => [SectionRef.headingKey(s.headingPath), s.sectionFile]),
  );

  const bulkContent = prependHeadings(sectionList, await sectionReader.readAllSections(docPath));

  const involvementMeta = await buildSectionInvolvementMeta(docPath, headingPaths, bulkContent);

  const blockedHeadingKeys = new Set<string>();
  {
    const lockIndex = await ProposalFsmLockIndex.build({
      statuses: BLOCKING_LOCK_STATUSES,
      excludeProposalId: proposalId.length > 0 ? proposalId : undefined,
    });
    for (const headingPath of headingPaths) {
      if (lockIndex.holderFor({ doc_path: docPath, heading_path: headingPath })) {
        blockedHeadingKeys.add(SectionRef.headingKey(headingPath));
      }
    }
  }

  const sections: GetDocumentSectionsResponse["sections"] = [];
  for (const headingPath of headingPaths) {
    const headingKey = SectionRef.headingKey(headingPath);
    const content = bulkContent.get(headingKey) ?? "";
    const meta = involvementMeta.get(headingKey);
    if (!meta) continue;

    const blocked = blockedHeadingKeys.has(headingKey);

    sections.push({
      heading: headingPath[headingPath.length - 1] ?? "",
      heading_path: headingPath,
      depth: headingPath.length,
      content,
      agentWritePolicy: meta.agentWritePolicy,
      crdt_session_active: meta.crdt_session_active,
      section_length_warning: meta.section_length_warning,
      word_count: meta.word_count,
      section_file: sectionFileByKey.get(headingKey) ?? "",
      fragment_key: fragmentKeyFromSectionFile(
        sectionFileByKey.get(headingKey) ?? "",
        headingPath.length === 0,
      ),
      last_editor: meta.last_editor,
      ...(blocked ? { blocked: true } : {}),
    });
  }

  return { response: { doc_path: docPath, sections }, headingPaths };
}

// ─── Structural mutations ───────────────────────────────

export type StructuralMutationResult =
  | { kind: "blocked"; proposalId: string; policyResult: HumanInvolvementPolicyResult }
  | { kind: "committed"; proposalId: string; committedHead: string; policyResult: HumanInvolvementPolicyResult };

async function evaluateAndMaybeCommit(
  proposalId: string,
  writerType: "human" | "agent",
): Promise<{ policyResult: HumanInvolvementPolicyResult; committedHead?: string }> {
  if (writerType === "human") {
    // Human-initiated structural mutations bypass Agent Write Policy entirely (spec 12).
    const committedHead = await commitProposalToCanonical(proposalId, {});
    return { policyResult: humanBypassPolicyResult(), committedHead };
  }
  const policyResult = await evaluateAgentWritePolicy(proposalId);
  if (!policyResult.canWrite) {
    return { policyResult };
  }
  const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);
  const committedHead = await commitProposalToCanonical(proposalId, committedMetadata);
  return { policyResult, committedHead };
}

export function hasActiveSession(docPath: string): boolean {
  return lookupDocSession(docPath) !== undefined;
}

export async function deleteSectionUseCase(
  docPath: string,
  headingPath: string[],
  writer: SectionWriter,
): Promise<StructuralMutationResult> {
  const { id: proposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Delete section "${headingPath.join(" > ")}" from ${docPath}`,
  );
  const editor = ProposalEditor.open(proposalId, "pending");
  await editor.deleteSection(docPath, headingPath);
  await updateProposalSections(proposalId, [{ doc_path: docPath, heading_path: headingPath }]);
  const { policyResult, committedHead } = await evaluateAndMaybeCommit(proposalId, writer.type);
  if (!committedHead) return { kind: "blocked", proposalId, policyResult };
  return { kind: "committed", proposalId, committedHead, policyResult };
}

export class SectionNotFoundForMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionNotFoundForMoveError";
  }
}

export async function moveSectionUseCase(
  docPath: string,
  headingPath: string[],
  newParentPath: string[],
  writer: SectionWriter,
): Promise<StructuralMutationResult> {
  const { id: proposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Move section "${headingPath.join(" > ")}" in ${docPath}`,
  );
  const editor = ProposalEditor.open(proposalId, "pending");

  const currentSection = (await editor.getSectionList(docPath)).find((entry) =>
    entry.headingPath.length === headingPath.length
    && entry.headingPath.every((segment, index) => segment === headingPath[index]),
  );
  if (!currentSection) {
    throw new SectionNotFoundForMoveError(`Section not found: ${headingPath.join(" > ")} in ${docPath}`);
  }
  const targetLevel = newParentPath.length === 0 ? currentSection.level : newParentPath.length + 1;

  await editor.moveSection(docPath, headingPath, newParentPath, targetLevel);
  await updateProposalSections(proposalId, [{ doc_path: docPath, heading_path: headingPath }]);
  const { policyResult, committedHead } = await evaluateAndMaybeCommit(proposalId, writer.type);
  if (!committedHead) return { kind: "blocked", proposalId, policyResult };
  return { kind: "committed", proposalId, committedHead, policyResult };
}

export interface RenameSectionResult {
  result: StructuralMutationResult;
  newHeadingPath: string[];
}

export async function renameSectionUseCase(
  docPath: string,
  headingPath: string[],
  newHeading: string,
  writer: SectionWriter,
): Promise<RenameSectionResult> {
  const { id: proposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Rename section "${headingPath.join(" > ")}" to "${newHeading}" in ${docPath}`,
  );
  const editor = ProposalEditor.open(proposalId, "pending");
  await editor.renameSection(docPath, headingPath, newHeading);
  const newHeadingPath = [...headingPath.slice(0, -1), newHeading];
  await updateProposalSections(proposalId, [{ doc_path: docPath, heading_path: newHeadingPath }]);
  const { policyResult, committedHead } = await evaluateAndMaybeCommit(proposalId, writer.type);
  if (!committedHead) return { result: { kind: "blocked", proposalId, policyResult }, newHeadingPath };
  return { result: { kind: "committed", proposalId, committedHead, policyResult }, newHeadingPath };
}
