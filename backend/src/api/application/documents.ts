import path from "node:path";
import { access } from "node:fs/promises";
import type {
  DocumentTreeEntry,
  GetDocumentResponse,
  GetDocumentsTreeResponse,
  ReadDocStructureResponse,
  SectionMeta,
  HumanInvolvementPolicyResult,
  WriterIdentity,
} from "../../types/shared.js";
import {
  getContentRoot,
  getDataRoot,
} from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { getHeadSha, gitLogRecent, isValidSha } from "../../storage/git-repo.js";
import {
  readAssembledDocument,
  DocumentAssemblyError,
  DocumentNotFoundError,
} from "../../storage/document-reader.js";
import { InvalidDocPathError, resolveDocPathUnderContent } from "../../storage/path-utils.js";
import {
  createTransientProposal,
} from "../../storage/proposal-repository.js";
import {
  readDocumentStructure,
  flattenStructureToHeadingPaths,
} from "../../storage/heading-resolver.js";
import { evaluateAgentWritePolicy, commitProposalToCanonical } from "../../storage/commit-pipeline.js";
import { AgentWritePolicy, humanBypassPolicyResult } from "../../domain/agent-write-policy.js";
import { SectionRef } from "../../domain/section-ref.js";
import {
  lookupDocSession,
  countEditorSockets,
  invalidateSessionForReplacement,
} from "../../crdt/ydoc-lifecycle.js";
import { requestDocSessionPublish } from "../../ws/crdt-ws-coordinator.js";
import {
  readDocumentsTree,
  DocumentsTreePathNotFoundError,
  InvalidDocumentsTreePathError,
} from "../../storage/documents-tree.js";
import {
  searchReadableText,
  DiscoveryValidationError,
  DiscoveryNotFoundError,
  SearchTextPatternError,
  SearchTextExecutionError,
} from "../../storage/discovery.js";
import { getDocReadPermission } from "../../auth/acl.js";
import { RoleName } from "../../types/shared.js";
import type { AuthenticatedWriter } from "../../auth/context.js";
import { buildSectionInvolvementMeta, broadcastAgentReading } from "../helpers/section-meta-builder.js";
import { openWorkspaceReader } from "./sections.js";

export { broadcastAgentReading };

export {
  DocumentNotFoundError,
  DocumentAssemblyError,
  InvalidDocPathError,
  DocumentsTreePathNotFoundError,
  InvalidDocumentsTreePathError,
  DiscoveryValidationError,
  DiscoveryNotFoundError,
  SearchTextPatternError,
  SearchTextExecutionError,
  isValidSha,
  flattenStructureToHeadingPaths,
};

export type DocumentWriter = Pick<WriterIdentity, "id" | "type" | "displayName" | "email">;

// ─── Tree ───────────────────────────────────────────────

async function filterTreeToPublic(entries: DocumentTreeEntry[]): Promise<DocumentTreeEntry[]> {
  const result: DocumentTreeEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "file") {
      const perm = await getDocReadPermission(entry.path);
      if (RoleName.text(perm) === "public") {
        result.push(entry);
      }
    } else {
      const children = await filterTreeToPublic(entry.children ?? []);
      if (children.length > 0) {
        result.push({ ...entry, children });
      }
    }
  }
  return result;
}

export async function readTree(basePath: string, isAuthenticated: boolean): Promise<GetDocumentsTreeResponse> {
  const tree = await readDocumentsTree(basePath);
  const filteredTree = isAuthenticated ? tree : await filterTreeToPublic(tree);
  return { tree: filteredTree };
}

// ─── Structure ──────────────────────────────────────────

export async function readCanonicalStructure(docPath: string): Promise<{ response: ReadDocStructureResponse; headingPaths: string[][] }> {
  // Canonical (committed) structure read: reads canonical content directly, never
  // a session/live overlay. The agent-facing surface. Proposal-preview structure
  // reads go through ProposalReader on an explicit proposal endpoint.
  const structure = await CanonicalReader.open().getDocumentStructure(docPath);
  return {
    response: { doc_path: docPath, structure },
    headingPaths: flattenStructureToHeadingPaths(structure),
  };
}

export async function readWorkspaceStructure(docPath: string): Promise<{ response: ReadDocStructureResponse; headingPaths: string[][] }> {
  // Working-copy structure read: resolves the in-progress proposal (if any) for
  // the doc, else canonical — the same reader selection as workspace section
  // reads (see openWorkspaceReader). No live-fragment assembly.
  const reader = await openWorkspaceReader(docPath);
  const structure = await reader.getDocumentStructure(docPath);
  return {
    response: { doc_path: docPath, structure },
    headingPaths: flattenStructureToHeadingPaths(structure),
  };
}

// ─── History / preview ──────────────────────────────────

export async function getHistory(docPath: string, limit: number, offset: number) {
  const dataRoot = getDataRoot();
  const entries = await gitLogRecent(dataRoot, { limit, offset, docPath });
  return { doc_path: docPath, versions: entries };
}

export async function getHistoryPreview(docPath: string, sha: string): Promise<{ doc_path: string; sha: string; content: string; corrupt: boolean; missingSections: string[] }> {
  const { assembleDocumentAtCommit } = await import("../../storage/git-repo.js");
  const dataRoot = getDataRoot();
  const { content, missingSections } = await assembleDocumentAtCommit(dataRoot, sha, docPath);
  if (missingSections.length > 0) {
    return { doc_path: docPath, sha, content, corrupt: true, missingSections };
  }
  return { doc_path: docPath, sha, content, corrupt: false, missingSections: [] };
}

// ─── Diagnostics ────────────────────────────────────────

export async function getDiagnostics(docPath: string) {
  const { buildDocumentDiagnostics } = await import("../../diagnostics/document-diagnostics/build-document-diagnostics.js");
  return buildDocumentDiagnostics(docPath);
}

// ─── Blame ──────────────────────────────────────────────

export async function getBlame(docPath: string, sectionFile: string) {
  const contentRoot = getContentRoot();
  const { absolutePath: sectionFilePath } = await new ContentLayer(contentRoot).resolveSectionFileId(docPath, sectionFile);

  const { computeSectionBlame } = await import("../../storage/section-blame.js");
  const lines = await computeSectionBlame(sectionFilePath);

  // Blame is computed on the body-only section file. The governance attribution
  // view renders the heading separately (as its own <h2>, outside the overlay)
  // and feeds the overlay body-only content, so blame lines align 1:1 with the
  // rendered body lines. Do NOT inject/offset heading lines here: a prior +2
  // offset assumed the renderer embedded the heading line, which it does not,
  // and that shifted every headed section's per-line colors down by two.
  return { lines };
}

// ─── Full document read (catch-all GET) ─────────────────

export async function readCanonicalDocument(docPath: string): Promise<{ response: GetDocumentResponse; headingPaths: string[][] }> {
  const assembled = await readAssembledDocument(docPath);

  const structure = await readDocumentStructure(docPath);
  const headingPaths = flattenStructureToHeadingPaths(structure);

  // Canonical-only read (MW-7): section metadata (word counts, length warnings,
  // agent-write-policy) is fed from canonical body content. No session/live
  // overlay is consulted; proposal content is read only on the explicit
  // proposal endpoint via ProposalReader.
  const bulkContent = await CanonicalReader.open().readAllSections(docPath);
  const involvementMeta = await buildSectionInvolvementMeta(docPath, headingPaths, bulkContent);

  const sectionsMeta: SectionMeta[] = [];
  for (const headingPath of headingPaths) {
    const headingKey = SectionRef.headingKey(headingPath);
    const meta = involvementMeta.get(headingKey);
    if (!meta) continue;
    sectionsMeta.push({
      heading_path: headingPath,
      agentWritePolicy: meta.agentWritePolicy,
      crdt_session_active: meta.crdt_session_active,
      section_length_warning: meta.section_length_warning,
      word_count: meta.word_count,
    });
  }

  const headSha = await getHeadSha(getDataRoot());
  return {
    response: {
      doc_path: docPath,
      content: assembled,
      head_sha: headSha,
      sections_meta: sectionsMeta,
    },
    headingPaths: sectionsMeta.map((s) => s.heading_path),
  };
}

// ─── Search ─────────────────────────────────────────────

export interface SearchQuery {
  pattern: string;
  syntax: "literal" | "regexp";
  root?: string;
  case_sensitive?: boolean;
  max_results?: number;
  context_bytes?: number;
}

export async function search(writer: AuthenticatedWriter | null, query: SearchQuery) {
  return searchReadableText(writer, query);
}

// ─── Export ─────────────────────────────────────────────

export interface ExportResult {
  stream: NodeJS.ReadableStream;
  filename: string;
}

export async function buildExport(browsePath: string): Promise<ExportResult> {
  const tree = await readDocumentsTree(browsePath, true);

  const filePaths: string[] = [];
  const walk = (nodes: DocumentTreeEntry[]) => {
    for (const node of nodes) {
      if (node.type === "file") {
        filePaths.push(node.path);
      } else if (node.children) {
        walk(node.children);
      }
    }
  };
  walk(tree);

  const { ZipFile } = await import("yazl");
  const zipFile = new ZipFile();

  const exportErrors: string[] = [];
  for (const docPath of filePaths) {
    try {
      const assembled = await readAssembledDocument(docPath);
      const zipPath = docPath.replace(/^\/+/, "");
      zipFile.addBuffer(Buffer.from(assembled, "utf8"), zipPath);
    } catch (assemblyError) {
      const msg = assemblyError instanceof Error
        ? assemblyError.stack ?? assemblyError.message
        : String(assemblyError);
      exportErrors.push(`${docPath}: ${msg}`);
    }
  }

  if (exportErrors.length > 0) {
    zipFile.addBuffer(Buffer.from(exportErrors.join("\n\n"), "utf8"), "export-errors.txt");
  }

  zipFile.end();

  const folderName = browsePath === "/" ? "all" : browsePath.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\//g, "-") || "all";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `export-${folderName}-${timestamp}.zip`;

  return { stream: zipFile.outputStream, filename };
}

// ─── Shared structural-commit helper ────────────────────

async function evaluateAndMaybeCommitDocumentProposal(
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

export type StructuralCommitResult =
  | { kind: "blocked"; proposalId: string; policyResult: HumanInvolvementPolicyResult }
  | { kind: "committed"; proposalId: string; committedHead: string; policyResult: HumanInvolvementPolicyResult };

// ─── Restore (forced-canonical-replacement) ─────────────

// Re-export the real constructor thrown by the restore service so route-level
// `instanceof` checks narrow against the actual class (not a duplicate shadow).
export { RestoreValidationError } from "../../storage/restore-service.js";

/**
 * Thrown when a forced canonical replacement (restore/overwrite) cannot first
 * safely hand off the live DocSession's in-flight edits into canonical (C5;
 * spec 05 §Restore "Pre-emptive Session Handoff" step 2 — if the publish pause
 * aborts or the commit fails, STOP and leave the current proposal active). The
 * message is prose suitable for surfacing to the admin.
 */
export class DocSessionHandoffFailedError extends Error {}

/**
 * Gate a forced canonical replacement on the pre-handoff publish outcome (C5).
 * Proceed only when the live state was committed or there was nothing to publish;
 * on abort/failure throw so the caller does NOT replace canonical or tear down
 * the live Y.Doc (the unpublished in-flight edits must survive).
 */
function assertHandoffSucceeded(publish: { outcome: string; message?: string }): void {
  if (publish.outcome === "committed" || publish.outcome === "noop") return;
  throw new DocSessionHandoffFailedError(
    publish.message
      ?? "Couldn't safely preserve in-progress edits before replacing this document — active editors must pause and retry.",
  );
}

export async function restoreDocument(docPath: string, sha: string, writer: DocumentWriter): Promise<{ committedSha: string }> {
  // Inherit Writer-Type from the target commit so blame attribution reflects
  // the original author, not who clicked the restore button.
  const { getCommitWriterType } = await import("../../storage/git-repo.js");
  const targetWriterType = await getCommitWriterType(getDataRoot(), sha);
  const restoreWriter: DocumentWriter = targetWriterType
    ? { ...writer, type: targetWriterType }
    : writer;

  // Preserve current live state before restore replaces canonical content
  // (spec 05 §Restore: Pre-emptive Session Handoff). Drive the DocSession actor
  // through the publish pause; no-op when there is no current proposal. C5: if the
  // handoff publish ABORTS (editor never acked / timed out) or FAILS, STOP — do
  // not create the restore proposal, commit, or tear down the live Y.Doc; the
  // unpublished in-flight edits must survive.
  assertHandoffSucceeded(await requestDocSessionPublish(docPath));

  const { createRestoreProposal } = await import("../../storage/restore-service.js");
  const { proposal } = await createRestoreProposal(docPath, sha, restoreWriter);

  const committedSha = await commitProposalToCanonical(proposal.id, {}, undefined, { restoreTargetSha: sha });

  await invalidateSessionForReplacement(docPath, { message: "document was restored to an earlier version" });
  return { committedSha };
}

// ─── Overwrite ──────────────────────────────────────────

export class DocumentDoesNotExistError extends Error {}

export async function overwriteDocument(docPath: string, markdown: string, admin: DocumentWriter): Promise<{ committedSha: string }> {
  const contentRoot = getContentRoot();
  const resolvedPath = resolveDocPathUnderContent(contentRoot, docPath);
  try {
    await access(resolvedPath);
  } catch {
    throw new DocumentDoesNotExistError(`Document "${docPath}" does not exist in canonical. Use import for new documents.`);
  }

  // C5: gate on the pre-handoff publish BEFORE creating any proposal, so a failed
  // handoff leaves no orphan proposal and does not replace canonical / tear down
  // the live Y.Doc.
  assertHandoffSucceeded(await requestDocSessionPublish(docPath));

  const { id: proposalId } = await createTransientProposal(
    { id: admin.id, type: admin.type, displayName: admin.displayName, email: admin.email },
    `Admin overwrite: ${docPath}`,
  );

  await mutateProposalContent(proposalId, {
    kind: "write_document_markdown",
    files: [{ docPath, markdown }],
  });

  const committedSha = await commitProposalToCanonical(proposalId, {}, undefined, {});

  await invalidateSessionForReplacement(docPath, { message: "admin overwrote this document" });
  return { committedSha };
}

// ─── Rename document ────────────────────────────────────

export class ActiveSessionConflictError extends Error {}

export interface RenameDocumentResult {
  result: StructuralCommitResult;
}

export async function renameDocument(docPath: string, newPath: string, writer: DocumentWriter): Promise<StructuralCommitResult> {
  const docSession = lookupDocSession(docPath);
  if (docSession && countEditorSockets(docSession) > 0) {
    throw new ActiveSessionConflictError("Cannot rename document with active editing session.");
  }

  const { id: proposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Rename document: ${docPath} -> ${newPath}`,
  );
  await mutateProposalContent(proposalId, { kind: "rename_document", docPath, newPath });
  const { policyResult, committedHead } = await evaluateAndMaybeCommitDocumentProposal(proposalId, writer.type);
  if (!committedHead) return { kind: "blocked", proposalId, policyResult };
  return { kind: "committed", proposalId, committedHead, policyResult };
}

// ─── Create document (catch-all PUT) ────────────────────

export class DocumentAlreadyExistsError extends Error {}
export class DocumentPendingDeletionError extends Error {}

export async function createDocument(docPath: string, writer: DocumentWriter): Promise<StructuralCommitResult> {
  const contentRoot = getContentRoot();
  // Validate the doc path (throws InvalidDocPathError on traversal/.md failures).
  resolveDocPathUnderContent(contentRoot, docPath);

  const { id: proposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Create document: ${docPath}`,
  );
  const state = await ProposalReader.open(proposalId, "pending").getDocumentState(docPath);
  if (state === "live") {
    throw new DocumentAlreadyExistsError("Document already exists.");
  }
  if (state === "tombstone") {
    throw new DocumentPendingDeletionError("Document is pending deletion.");
  }
  await mutateProposalContent(proposalId, { kind: "create_document", docPath });
  const { policyResult, committedHead } = await evaluateAndMaybeCommitDocumentProposal(proposalId, writer.type);
  if (!committedHead) return { kind: "blocked", proposalId, policyResult };
  return { kind: "committed", proposalId, committedHead, policyResult };
}

// ─── Delete document (catch-all DELETE) ─────────────────

export class DocumentNotFoundForDeleteError extends Error {}
export class UncommittedSessionFilesError extends Error {}

export async function deleteDocument(docPath: string, writer: DocumentWriter): Promise<StructuralCommitResult> {
  const contentRoot = getContentRoot();
  const resolvedPath = resolveDocPathUnderContent(contentRoot, docPath);

  try {
    await access(resolvedPath);
  } catch {
    throw new DocumentNotFoundForDeleteError(`Document not found: ${docPath}`);
  }

  const docSession = lookupDocSession(docPath);
  if (docSession) {
    throw new ActiveSessionConflictError("Cannot delete document with active editing session.");
  }

  // Note (MW-7 / Area D): the legacy "uncommitted session files" probe against
  // the `sessions/sections` overlay was removed with that dead storage surface.
  // `sessions/` is never written in production; in-flight live edits are now
  // guarded entirely by the active-DocSession check above. UncommittedSessionFilesError
  // is retained as an exported type for the route handler but is no longer thrown.

  const { id: proposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Delete document: ${docPath}`,
  );
  await mutateProposalContent(proposalId, { kind: "delete_document", docPath });
  const { policyResult, committedHead } = await evaluateAndMaybeCommitDocumentProposal(proposalId, writer.type);
  if (!committedHead) return { kind: "blocked", proposalId, policyResult };
  return { kind: "committed", proposalId, committedHead, policyResult };
}
