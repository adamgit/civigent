import type {
  DocumentTreeEntry,
  GetDocumentResponse,
  GetDocumentsTreeResponse,
  ReadDocStructureResponse,
  SectionMeta,
  HumanInvolvementPolicyResult,
  WriterIdentity,
  ProposalTargetRef,
} from "../../types/shared.js";
import { isActiveProposal } from "../../types/shared.js";
import { getDataRoot } from "../../storage/data-root.js";
import { CanonicalReader } from "../../storage/canonical-reader.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { getHeadSha, gitLogRecent, isValidSha } from "../../storage/git-repo.js";
import {
  readAssembledDocument,
  canonicalDocumentExists,
  DirectoryAtDocPathError,
  DocumentAssemblyError,
  DocumentNotFoundError,
} from "../../storage/document-reader.js";
import { InvalidDocPathError, docPathToContentRelativeFsPath } from "../../storage/path-utils.js";
import {
  createTransientProposal,
} from "../../storage/proposal-repository.js";
import {
  readDocumentStructure,
  flattenStructureToHeadingPaths,
} from "../../storage/heading-resolver.js";
import { evaluateAgentWritePolicy, publishProposalToCanonical, publishProposalToCanonicalDetailed } from "../../storage/commit-pipeline.js";
import { propagateCommitToLiveSessions } from "../../ws/crdt-ws-coordinator.js";
import { AgentWritePolicy, humanBypassPolicyResult } from "../../domain/agent-write-policy.js";
import { SectionRef } from "../../domain/section-ref.js";
import {
  lookupDocSession,
  countEditorSockets,
  invalidateSessionForReplacement,
} from "../../crdt/ydoc-lifecycle.js";
import { requestDocSessionPublish, type PublishAttemptOutcome } from "../../ws/crdt-ws-coordinator.js";
import {
  readDocumentsTreeUnfiltered,
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
import { getDocReadPermission, getDocWritePermission, checkDocPermission } from "../../auth/acl.js";
import { authorizeDocRead, PermissionError, type AuthorizedDocRead } from "../../auth/authorized-read.js";
import { RoleName } from "../../types/shared.js";
import { DocPath, FolderPath, InvalidFolderPathError } from "../../types/shared.js";

import type { AuthenticatedWriter } from "../../auth/context.js";
import { buildSectionInvolvementMeta, broadcastAgentReading } from "../helpers/section-meta-builder.js";
import { openWorkspaceReader } from "./sections.js";
import { getExportedSkillsConfig } from "../../exported-skills-config.js";

export { broadcastAgentReading };

export {
  DirectoryAtDocPathError,
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

function annotateExportedSkillsPills(entries: DocumentTreeEntry[]): DocumentTreeEntry[] {
  const folder = getExportedSkillsConfig().folder;
  return entries.map((entry) => {
    const children = entry.children ? annotateExportedSkillsPills(entry.children) : entry.children;
    if (entry.type === "directory" && entry.path === folder) {
      return { ...entry, children, pills: ["skills", "public"] };
    }
    if (children !== entry.children) {
      return { ...entry, children };
    }
    return entry;
  });
}

async function annotateDirectoryAccess(entries: DocumentTreeEntry[]): Promise<DocumentTreeEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const children = entry.children ? await annotateDirectoryAccess(entry.children) : entry.children;
      if (entry.type === "directory") {
        const [read, write] = await Promise.all([
          getDocReadPermission(entry.path),
          getDocWritePermission(entry.path),
        ]);
        return { ...entry, children, access: { read, write } };
      }
      if (children !== entry.children) {
        return { ...entry, children };
      }
      return entry;
    }),
  );
}

async function filterTreeToReadable(
  writer: AuthenticatedWriter,
  entries: DocumentTreeEntry[],
): Promise<DocumentTreeEntry[]> {
  const result: DocumentTreeEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "file") {
      if (await checkDocPermission(writer, entry.path, "read")) {
        result.push(entry);
      }
    } else {
      const children = await filterTreeToReadable(writer, entry.children ?? []);
      if (children.length > 0) {
        result.push({ ...entry, children });
      }
    }
  }
  return result;
}

export async function readReadableTree(
  writer: AuthenticatedWriter | null,
  basePath: string,
): Promise<DocumentTreeEntry[]> {
  const tree = await readDocumentsTreeUnfiltered(basePath, true);
  if (writer === null) {
    return filterTreeToPublic(tree);
  }
  return filterTreeToReadable(writer, tree);
}

export async function readTree(
  writer: AuthenticatedWriter | null,
  basePath: string,
): Promise<GetDocumentsTreeResponse> {
  const tree = annotateExportedSkillsPills(await readDocumentsTreeUnfiltered(basePath));
  if (writer === null) {
    return { tree: await filterTreeToPublic(tree) };
  }
  return { tree: await annotateDirectoryAccess(await filterTreeToReadable(writer, tree)) };
}

// ─── Structure ──────────────────────────────────────────

export async function readCanonicalStructure(read: AuthorizedDocRead): Promise<{ response: ReadDocStructureResponse; headingPaths: string[][] }> {
  const docPath = read.docPath;
  // Canonical (committed) structure read: reads canonical content directly, never
  // a session/live overlay. The agent-facing surface. Proposal-preview structure
  // reads go through ProposalReader on an explicit proposal endpoint.
  const structure = await CanonicalReader.open().getDocumentStructure(docPath);
  return {
    response: { doc_path: docPath, structure },
    headingPaths: flattenStructureToHeadingPaths(structure),
  };
}

export async function readWorkspaceStructure(read: AuthorizedDocRead): Promise<{ response: ReadDocStructureResponse; headingPaths: string[][] }> {
  const docPath = read.docPath;
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

export async function getHistory(read: AuthorizedDocRead, limit: number, offset: number) {
  const docPath = read.docPath;
  const dataRoot = getDataRoot();
  const entries = await gitLogRecent(dataRoot, { limit, offset, docPath });
  return { doc_path: docPath, versions: entries };
}

export async function getHistoryPreview(read: AuthorizedDocRead, sha: string): Promise<{ doc_path: string; sha: string; content: string; corrupt: boolean; missingSections: string[] }> {
  const docPath = read.docPath;
  const { assembleDocumentAtCommit } = await import("../../storage/git-repo.js");
  const dataRoot = getDataRoot();
  const { content, missingSections } = await assembleDocumentAtCommit(dataRoot, sha, docPath);
  if (missingSections.length > 0) {
    return { doc_path: docPath, sha, content, corrupt: true, missingSections };
  }
  return { doc_path: docPath, sha, content, corrupt: false, missingSections: [] };
}

// ─── Diagnostics ────────────────────────────────────────

export async function getDiagnostics(docPath: DocPath) {
  const { buildDocumentDiagnostics } = await import("../../diagnostics/document-diagnostics/build-document-diagnostics.js");
  return buildDocumentDiagnostics(docPath);
}

// ─── Blame ──────────────────────────────────────────────

export async function getBlame(read: AuthorizedDocRead, sectionFile: string) {
  const docPath = read.docPath;
  const { absolutePath: sectionFilePath } = await CanonicalReader.open().resolveSectionFileId(docPath, sectionFile);

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

export async function readCanonicalDocument(read: AuthorizedDocRead): Promise<{ response: GetDocumentResponse; headingPaths: string[][] }> {
  const docPath = read.docPath;
  const assembled = await readAssembledDocument(read);

  const structure = await readDocumentStructure(docPath);
  const headingPaths = flattenStructureToHeadingPaths(structure);

  // Canonical-only read (MW-7): section metadata (agent-write-policy,
  // last-editor, session liveness) comes from commit/session state — not from
  // a body read. No session/live overlay is consulted; proposal content is read
  // only on the explicit proposal endpoint via ProposalReader.
  const involvementMeta = await buildSectionInvolvementMeta(docPath, headingPaths);

  const sectionsMeta: SectionMeta[] = [];
  for (const headingPath of headingPaths) {
    const headingKey = SectionRef.headingKey(headingPath);
    const meta = involvementMeta.get(headingKey);
    if (!meta) continue;
    sectionsMeta.push({
      heading_path: headingPath,
      agentWritePolicy: meta.agentWritePolicy,
      crdt_session_active: meta.crdt_session_active,
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

// ─── Live markdown export (raw fragment truth) ──────────

export async function readLiveDocumentMarkdown(read: AuthorizedDocRead): Promise<string> {
  const docPath = read.docPath;
  const session = lookupDocSession(docPath);
  if (session) {
    // Raw fragment truth in current layout order — deliberately bypasses
    // classification/materialization so the export works even when settle
    // cannot. This is the standing escape hatch for a user's live content.
    const { resolveLiveSectionLayout } = await import("../../crdt/live-section-layout.js");
    const layout = await resolveLiveSectionLayout(docPath, session.generator.getCurrentProposalId());
    const parts = layout
      .map((entry) => session.liveFragments.readFragmentString(entry.fragmentKey).trim())
      .filter((fragment) => fragment.length > 0);
    return parts.join("\n\n");
  }

  const { buildFragmentContent, EMPTY_BODY } = await import("../../storage/section-formatting.js");
  const reader = await openWorkspaceReader(docPath);
  const sections = await reader.listEffectiveSections(docPath);
  const bodies = await reader.readAllEffectiveSections(docPath);
  const parts: string[] = [];
  for (const section of sections) {
    const body = bodies.get(SectionRef.headingKey(section.headingPath)) ?? EMPTY_BODY;
    const fragment =
      section.headingPath.length === 0
        ? body
        : buildFragmentContent(body, section.headingLevel, section.heading);
    if (fragment.trim().length > 0) parts.push(fragment.trim());
  }
  return parts.join("\n\n");
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

export type ExportLayout = "relative" | "absolute";

export async function buildExport(
  writer: AuthenticatedWriter | null,
  browsePath: string,
  layout: ExportLayout = "relative",
): Promise<ExportResult> {
  const tree = await readReadableTree(writer, browsePath);
  const exportFolder = layout === "absolute" ? FolderPath.root : FolderPath.normalize(browsePath);

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
      const assembled = await readAssembledDocument(await authorizeDocRead(writer, DocPath.parse(docPath)));
      const zipPath = docPathToContentRelativeFsPath(
        FolderPath.rebaseDocPath(DocPath.parse(docPath), exportFolder, FolderPath.root),
      );
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
    const absorbResult = await publishProposalToCanonicalDetailed(proposalId, {});
    const committedHead = absorbResult.commitSha;
    await propagateCommitToLiveSessions(absorbResult, proposalId);
    return { policyResult: humanBypassPolicyResult(), committedHead };
  }
  const policyResult = await evaluateAgentWritePolicy(proposalId);
  if (!policyResult.canWrite) {
    return { policyResult };
  }
  const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);
  const absorbResult = await publishProposalToCanonicalDetailed(proposalId, committedMetadata);
  const committedHead = absorbResult.commitSha;
  await propagateCommitToLiveSessions(absorbResult, proposalId);
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

/**
 * User-initiated force publish of a document's live in-flight edits.
 *
 * Unlike the autonomous publish triggers (quiescence, last-editor-disconnect),
 * this is a REQUEST/RESPONSE call: `requestDocSessionPublish` returns the
 * `PublishAttemptOutcome` directly and does NOT route `aborted`/`failed` through
 * `surfacePublishOutcome` (the process-fatal boundary). Those outcomes are a
 * normal user-facing result here — the caller has a UI to show them — so we
 * return the outcome verbatim (FP2) rather than treating a non-success as a
 * server error. `noop` (no live session / no in-flight proposal) is likewise a
 * legitimate outcome, not a failure.
 */
export async function forcePublishDocument(docPath: DocPath): Promise<PublishAttemptOutcome> {
  return requestDocSessionPublish(docPath);
}

export async function restoreDocument(docPath: DocPath, sha: string, writer: DocumentWriter): Promise<{ committedSha: string; targets: ProposalTargetRef[] }> {
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
  if (!isActiveProposal(proposal)) {
    throw new Error(`Restore proposal ${proposal.id} is not active after creation (status: ${proposal.status}).`);
  }
  const targets = proposal.targets;

  const committedSha = await publishProposalToCanonical(proposal.id, {}, undefined, {
    authority: writer,
    restoreTargetSha: sha,
  });

  await invalidateSessionForReplacement(docPath, { message: "document was restored to an earlier version" });
  return { committedSha, targets };
}

// ─── Overwrite ──────────────────────────────────────────

export class DocumentDoesNotExistError extends Error {}

export async function adminOverwriteDocument(docPath: DocPath, markdown: string, admin: DocumentWriter): Promise<{ committedSha: string; targets: ProposalTargetRef[] }> {
  if (!(await canonicalDocumentExists(docPath))) {
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

  const { manifest } = await mutateProposalContent(proposalId, {
    kind: "write_document_markdown",
    files: [{ docPath, markdown }],
  });

  const committedSha = await publishProposalToCanonical(proposalId, {}, undefined, {});

  await invalidateSessionForReplacement(docPath, { message: "admin overwrote this document" });
  return { committedSha, targets: manifest.targets };
}

// ─── Rename document ────────────────────────────────────

export class ActiveSessionConflictError extends Error {}

export interface RenameDocumentResult {
  result: StructuralCommitResult;
}

export async function renameDocument(docPath: DocPath, newPath: DocPath, writer: DocumentWriter): Promise<StructuralCommitResult> {
  const docSession = lookupDocSession(docPath);
  if (docSession && countEditorSockets(docSession) > 0) {
    throw new ActiveSessionConflictError("Cannot rename document with active editing session.");
  }

  if (!(await checkDocPermission(writer, newPath, "write"))) {
    throw new PermissionError(`Write permission denied for rename destination: ${newPath}`, false);
  }

  if (await canonicalDocumentExists(newPath)) {
    throw new DocumentAlreadyExistsError(`Document already exists: ${newPath}`);
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

export async function createDocument(docPath: DocPath, writer: DocumentWriter, initialMarkdown?: string): Promise<StructuralCommitResult> {
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
  if (typeof initialMarkdown === "string" && initialMarkdown.length > 0) {
    await mutateProposalContent(proposalId, {
      kind: "write_document_markdown",
      files: [{ docPath, markdown: initialMarkdown }],
    });
  }
  const { policyResult, committedHead } = await evaluateAndMaybeCommitDocumentProposal(proposalId, writer.type);
  if (!committedHead) return { kind: "blocked", proposalId, policyResult };
  return { kind: "committed", proposalId, committedHead, policyResult };
}

// ─── Delete document (catch-all DELETE) ─────────────────

export class DocumentNotFoundForDeleteError extends Error {}
export class UncommittedSessionFilesError extends Error {}

export async function deleteDocument(docPath: DocPath, writer: DocumentWriter): Promise<StructuralCommitResult> {
  if (!(await canonicalDocumentExists(docPath))) {
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

// ─── Folder operations (delete / rename) ────────────────

export class FolderWritePermissionError extends Error {
  constructor(
    readonly folder: FolderPath,
    readonly deniedDocPaths: DocPath[],
  ) {
    super(`Write permission denied for documents in folder ${folder}: ${deniedDocPaths.join(", ")}`);
  }
}

async function listFolderDescendantDocs(folder: FolderPath): Promise<DocPath[]> {
  const tree = await readDocumentsTreeUnfiltered(folder, true);
  const docPaths: DocPath[] = [];
  const walk = (nodes: DocumentTreeEntry[]): void => {
    for (const node of nodes) {
      if (node.type === "file") {
        docPaths.push(DocPath.parse(node.path));
        continue;
      }
      walk(node.children ?? []);
    }
  };
  walk(tree);
  if (docPaths.length === 0) {
    throw new DocumentsTreePathNotFoundError(`Folder contains no documents: ${folder}`);
  }
  return docPaths;
}

export async function deleteFolder(
  folder: FolderPath,
  writer: DocumentWriter,
): Promise<{ result: StructuralCommitResult; deletedDocPaths: DocPath[] }> {
  if (folder === FolderPath.root) {
    throw new InvalidFolderPathError("cannot delete the content root");
  }
  const deletedDocPaths = await listFolderDescendantDocs(folder);

  const denied: DocPath[] = [];
  for (const doc of deletedDocPaths) {
    if (!(await checkDocPermission(writer, doc, "write"))) {
      denied.push(doc);
    }
  }
  if (denied.length > 0) {
    throw new FolderWritePermissionError(folder, denied);
  }

  for (const doc of deletedDocPaths) {
    if (lookupDocSession(doc)) {
      throw new ActiveSessionConflictError(`Cannot delete document with active editing session: ${doc}`);
    }
  }

  const { id: proposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Delete folder: ${folder} (${deletedDocPaths.length} documents)`,
  );
  for (const doc of deletedDocPaths) {
    await mutateProposalContent(proposalId, { kind: "delete_document", docPath: doc });
  }
  const { policyResult, committedHead } = await evaluateAndMaybeCommitDocumentProposal(proposalId, writer.type);
  const result: StructuralCommitResult = committedHead
    ? { kind: "committed", proposalId, committedHead, policyResult }
    : { kind: "blocked", proposalId, policyResult };
  return { result, deletedDocPaths };
}

export async function renameFolder(
  from: FolderPath,
  to: FolderPath,
  writer: DocumentWriter,
): Promise<{ result: StructuralCommitResult; renames: Array<{ from: DocPath; to: DocPath }> }> {
  if (from === FolderPath.root || to === FolderPath.root) {
    throw new InvalidFolderPathError("cannot rename the content root or rename a folder to the content root");
  }
  if (from === to) {
    throw new InvalidFolderPathError(`cannot rename folder ${from} to itself`);
  }
  if (FolderPath.contains(from, to)) {
    throw new InvalidFolderPathError(`cannot rename folder ${from} into its own subtree ${to}`);
  }

  const sourceDocs = await listFolderDescendantDocs(from);

  const renames: Array<{ from: DocPath; to: DocPath }> = [];
  for (const doc of sourceDocs) {
    const newDoc = FolderPath.rebaseDocPath(doc, from, to);
    if (await canonicalDocumentExists(newDoc)) {
      throw new DocumentAlreadyExistsError(`Document already exists: ${newDoc}`);
    }
    renames.push({ from: doc, to: newDoc });
  }

  const denied: DocPath[] = [];
  for (const { from: sourceDoc, to: targetDoc } of renames) {
    if (!(await checkDocPermission(writer, sourceDoc, "write"))) {
      denied.push(sourceDoc);
    }
    if (!(await checkDocPermission(writer, targetDoc, "write"))) {
      denied.push(targetDoc);
    }
  }
  if (denied.length > 0) {
    throw new FolderWritePermissionError(from, denied);
  }

  for (const { from: sourceDoc } of renames) {
    const docSession = lookupDocSession(sourceDoc);
    if (docSession && countEditorSockets(docSession) > 0) {
      throw new ActiveSessionConflictError(`Cannot rename document with active editing session: ${sourceDoc}`);
    }
  }

  const { id: proposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Rename folder: ${from} -> ${to} (${renames.length} documents)`,
  );
  for (const { from: sourceDoc, to: targetDoc } of renames) {
    await mutateProposalContent(proposalId, { kind: "rename_document", docPath: sourceDoc, newPath: targetDoc });
  }
  const { policyResult, committedHead } = await evaluateAndMaybeCommitDocumentProposal(proposalId, writer.type);
  const result: StructuralCommitResult = committedHead
    ? { kind: "committed", proposalId, committedHead, policyResult }
    : { kind: "blocked", proposalId, policyResult };
  return { result, renames };
}
