import type {
  GetDocumentSectionsResponse,
  HumanInvolvementPolicyResult,
  WriterIdentity,
} from "../../types/shared.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";
import { mutateProposalContent, ProposalSectionNotFoundError } from "../../storage/mutate-proposal-content.js";
import { prependHeadings } from "../../storage/document-reader.js";
import { SectionNotFoundError } from "../../storage/section-reader.js";
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
  findInProgressProposalForDoc,
} from "../../storage/proposal-repository.js";
import { evaluateAgentWritePolicy, commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { AgentWritePolicy, humanBypassPolicyResult } from "../../domain/agent-write-policy.js";
import { ProposalFsmLockIndex } from "../../domain/proposal-fsm-lock-index.js";
import { BLOCKING_LOCK_STATUSES } from "../../domain/proposal-fsm-locks.js";
import { SectionRef } from "../../domain/section-ref.js";
import { fragmentKeyFromSectionFile } from "../../crdt/ydoc-fragments.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import type { LiveFragmentStringsStore } from "../../crdt/live-fragment-strings-store.js";
import type { FragmentContent } from "../../storage/section-formatting.js";
import { requestDocSessionMove, type MoveSectionResult } from "../../ws/crdt-ws-coordinator.js";
import { buildSectionInvolvementMeta, broadcastAgentReading } from "../helpers/section-meta-builder.js";

export { broadcastAgentReading };

export type SectionWriter = Pick<WriterIdentity, "id" | "type" | "displayName" | "email">;



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





export async function verifyProposalForRead(proposalId: string, writerId: string): Promise<void> {
  const proposal = await readProposal(proposalId);
  if (proposal.writer.id !== writerId) {
    throw new SectionsReadForbiddenError("You can only read sections using your own proposal.");
  }
}


interface SectionListReader {
  getSectionList(docPath: string): Promise<Array<{ heading: string; level: number; sectionFile: string; headingPath: string[] }>>;
  readAllSections(docPath: string): Promise<Map<string, import("../../storage/section-formatting.js").SectionBody>>;
}






export async function readCanonicalSectionList(docPath: string): Promise<ReadSectionListResult> {
  return buildSectionListResponse(docPath, CanonicalReader.open(), undefined);
}

export async function openWorkspaceReader(docPath: string): Promise<CanonicalReader | ProposalReader> {
  const inProgress = await findInProgressProposalForDoc(docPath);
  if (inProgress) {
    return ProposalReader.open(inProgress.id, "inprogress");
  }
  return CanonicalReader.open();
}

export async function readWorkspaceSectionList(docPath: string): Promise<ReadSectionListResult> {
  const session = lookupDocSession(docPath);
  return buildSectionListResponse(
    docPath,
    await openWorkspaceReader(docPath),
    undefined,
    session?.liveFragments,
  );
}








export async function readProposalSectionList(proposalId: string, docPath: string): Promise<ReadSectionListResult> {
  const proposal = await readProposal(proposalId);
  return buildSectionListResponse(docPath, ProposalReader.open(proposal.id, proposal.status), proposalId);
}






export async function readProposalAllSections(
  proposalId: string,
): Promise<{ documents: GetDocumentSectionsResponse[] }> {
  const proposal = await readProposal(proposalId);
  const reader = ProposalReader.open(proposal.id, proposal.status);

  
  const docPaths: string[] = [];
  const seen = new Set<string>();
  for (const section of proposal.sections) {
    if (!seen.has(section.doc_path)) {
      seen.add(section.doc_path);
      docPaths.push(section.doc_path);
    }
  }

  const documents: GetDocumentSectionsResponse[] = [];
  for (const docPath of docPaths) {
    const { response } = await buildSectionListResponse(docPath, reader, proposalId);
    documents.push(response);
  }
  return { documents };
}

function buildLiveSectionContent(
  sectionList: Array<{ headingPath: string[]; sectionFile: string }>,
  liveFragments: LiveFragmentStringsStore,
): Map<string, FragmentContent> {
  const bulkContent = new Map<string, FragmentContent>();
  for (const s of sectionList) {
    const headingKey = SectionRef.headingKey(s.headingPath);
    const fragmentKey = fragmentKeyFromSectionFile(s.sectionFile, s.headingPath.length === 0);
    bulkContent.set(headingKey, liveFragments.readFragmentString(fragmentKey));
  }
  return bulkContent;
}

async function buildSectionListResponse(
  docPath: string,
  sectionReader: SectionListReader,
  excludeProposalId: string | undefined,
  liveFragments?: LiveFragmentStringsStore,
): Promise<ReadSectionListResult> {
  const sectionList = await sectionReader.getSectionList(docPath);

  const headingPaths: string[][] = sectionList.map((s) => s.headingPath);
  const sectionFileByKey = new Map<string, string>(
    sectionList.map((s) => [SectionRef.headingKey(s.headingPath), s.sectionFile]),
  );

  const bulkContent = liveFragments
    ? buildLiveSectionContent(sectionList, liveFragments)
    : prependHeadings(sectionList, await sectionReader.readAllSections(docPath));

  const involvementMeta = await buildSectionInvolvementMeta(docPath, headingPaths);

  const blockedHeadingKeys = new Set<string>();
  {
    const lockIndex = await ProposalFsmLockIndex.build({
      statuses: BLOCKING_LOCK_STATUSES,
      excludeProposalId,
    });
    for (const headingPath of headingPaths) {
      if (lockIndex.holderFor({ kind: "section", doc_path: docPath, heading_path: headingPath })) {
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

    const locked = blockedHeadingKeys.has(headingKey);

    sections.push({
      heading: headingPath[headingPath.length - 1] ?? "",
      heading_path: headingPath,
      depth: headingPath.length,
      content,
      agentWritePolicy: meta.agentWritePolicy,
      crdt_session_active: meta.crdt_session_active,
      section_file: sectionFileByKey.get(headingKey) ?? "",
      fragment_key: fragmentKeyFromSectionFile(
        sectionFileByKey.get(headingKey) ?? "",
        headingPath.length === 0,
      ),
      last_editor: meta.last_editor,
      ...(locked ? { locked: true } : {}),
    });
  }

  return { response: { doc_path: docPath, sections }, headingPaths };
}



export type StructuralMutationResult =
  | { kind: "blocked"; proposalId: string; policyResult: HumanInvolvementPolicyResult }
  | { kind: "committed"; proposalId: string; committedHead: string; policyResult: HumanInvolvementPolicyResult };

async function evaluateAndMaybeCommit(
  proposalId: string,
  writerType: "human" | "agent",
): Promise<{ policyResult: HumanInvolvementPolicyResult; committedHead?: string }> {
  if (writerType === "human") {
    
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













export async function liveMoveSectionUseCase(
  docPath: string,
  sourceHeadingPath: string[],
  targetHeadingPath: string[],
  position: "before" | "after",
): Promise<MoveSectionResult> {
  return requestDocSessionMove(docPath, { sourceHeadingPath, targetHeadingPath, position });
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
  
  
  await mutateProposalContent(proposalId, { kind: "delete_section", docPath, headingPath });
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

  
  
  try {
    await mutateProposalContent(proposalId, { kind: "move_section", docPath, headingPath, newParentPath });
  } catch (error) {
    if (error instanceof ProposalSectionNotFoundError) {
      throw new SectionNotFoundForMoveError(error.message);
    }
    throw error;
  }
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
  
  
  const { newHeadingPath: resultHeadingPath } = await mutateProposalContent(proposalId, {
    kind: "rename_section",
    docPath,
    headingPath,
    newHeading,
  });
  const newHeadingPath = resultHeadingPath ?? [...headingPath.slice(0, -1), newHeading];
  const { policyResult, committedHead } = await evaluateAndMaybeCommit(proposalId, writer.type);
  if (!committedHead) return { result: { kind: "blocked", proposalId, policyResult }, newHeadingPath };
  return { result: { kind: "committed", proposalId, committedHead, policyResult }, newHeadingPath };
}
