/**
 * Tier 1 + Tier 2 MCP tools — filesystem-compatible surface.
 *
 * Tools: read_file, write_file, write_files, apply_patch, list_directory,
 *        delete_file, move_file, plan_changes
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult, textToolResult, jsonBlockedToolResult } from "../tool-registry.js";
import { AgentPayloadContract } from "../agent-payload-contract.js";
import { makeToolErrorResult, parseToolArgumentDocPath } from "../protocol.js";
import type { DocPath } from "../../types/shared.js";
import { readAssembledDocument, canonicalDocumentExists, DocumentNotFoundError } from "../../storage/document-reader.js";
import { readDocumentsTreeUnfiltered } from "../../storage/documents-tree.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { readDocumentStructure, flattenStructureToHeadingPaths } from "../../storage/heading-resolver.js";
import {
  createTransientProposal,
  demoteTransientProposalToDraft,
  transitionToWithdrawn,
} from "../../storage/proposal-repository.js";
import { rememberSessionDraft, takeCurrentSessionDraft } from "../session-drafts.js";
import { InvalidDocPathError } from "../../storage/path-utils.js";
import { applyUnifiedDiff, DiffParseError, DiffApplyError } from "../../storage/diff-parser.js";
import {
  evaluateAgentWritePolicy,
  publishProposalToCanonical,
  publishProposalToCanonicalDetailed,
} from "../../storage/commit-pipeline.js";
import { propagateCommitToLiveSessions } from "../../ws/crdt-ws-coordinator.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { agentWritePolicyToolBody } from "./agent-write-policy-body.js";
import { checkDocPermission } from "../../auth/acl.js";
import { authorizeDocRead, PermissionError } from "../../auth/authorized-read.js";
import { emitCatalogMutationEvents } from "../catalog-events.js";
import { emitContentCommittedEventsByDoc } from "../../api/application/events.js";

// ─── read_file ───────────────────────────────────────────

const readFileHandler: ToolHandler = async (args, ctx) => {
  const rawFilePath = args.path as string | undefined;
  if (!rawFilePath) {
    return makeToolErrorResult("Missing required parameter: path");
  }
  const parsedFilePath = parseToolArgumentDocPath(rawFilePath);
  if ("errorResult" in parsedFilePath) return parsedFilePath.errorResult;
  const filePath = parsedFilePath.docPath;

  let authorizedRead;
  try {
    authorizedRead = await authorizeDocRead(ctx.writer, filePath);
  } catch (error) {
    if (error instanceof PermissionError) {
      return makeToolErrorResult(`Permission denied: you do not have read access to "${filePath}".`);
    }
    throw error;
  }

  try {
    const content = await readAssembledDocument(authorizedRead);

    // Broadcast agent:reading
    if (ctx.writer.type === "agent" && ctx.emitEvent) {
      const structure = await readDocumentStructure(filePath);
      const headingPaths = flattenStructureToHeadingPaths(structure);
      ctx.emitEvent({
        type: "agent:reading",
        actor_id: ctx.writer.id,
        actor_display_name: ctx.writer.displayName,
        doc_path: filePath,
        heading_paths: headingPaths,
      });
    }

    return textToolResult(content);
  } catch (error) {
    if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Document not found: ${filePath}`);
    }
    throw error;
  }
};

// ─── write_file ──────────────────────────────────────────

const writeFileHandler: ToolHandler = async (args, ctx) => {
  const rawFilePath = args.path as string | undefined;
  const content = args.content as string | undefined;

  if (!rawFilePath) return makeToolErrorResult("Missing required parameter: path");
  if (content === undefined) return makeToolErrorResult("Missing required parameter: content");

  const refused = AgentPayloadContract.refuseMalformedMarkdown(args.content);
  if (refused) return refused;

  const parsedFilePath = parseToolArgumentDocPath(rawFilePath);
  if ("errorResult" in parsedFilePath) return parsedFilePath.errorResult;
  const filePath = parsedFilePath.docPath;

  return writeDocumentViaProposal(
    [{ path: filePath, content }],
    ctx,
  );
};

// ─── write_files ─────────────────────────────────────────

const writeFilesHandler: ToolHandler = async (args, ctx) => {
  const files = args.files as Array<{ path: string; content: string }> | undefined;

  if (!Array.isArray(files) || files.length === 0) {
    return makeToolErrorResult("Missing required parameter: files (array of {path, content})");
  }

  const parsedFiles: Array<{ path: DocPath; content: string }> = [];
  for (const file of files) {
    if (!file.path || file.content === undefined) {
      return makeToolErrorResult("Each file must have path and content");
    }
    const refused = AgentPayloadContract.refuseMalformedMarkdown(file.content);
    if (refused) return refused;
    const parsedFilePath = parseToolArgumentDocPath(file.path);
    if ("errorResult" in parsedFilePath) return parsedFilePath.errorResult;
    parsedFiles.push({ path: parsedFilePath.docPath, content: file.content });
  }

  return writeDocumentViaProposal(parsedFiles, ctx);
};

// ─── list_directory ──────────────────────────────────────

const listDirectoryHandler: ToolHandler = async (args) => {
  const dirPath = (args.path as string | undefined) ?? "";

  try {
    const tree = await readDocumentsTreeUnfiltered(dirPath);
    return jsonToolResult({ entries: tree });
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Invalid path: ${dirPath}`);
    }
    throw error;
  }
};

// ─── delete_file ─────────────────────────────────────────

const deleteFileHandler: ToolHandler = async (args, ctx) => {
  const rawFilePath = args.path as string | undefined;
  if (!rawFilePath) return makeToolErrorResult("Missing required parameter: path");

  const parsedFilePath = parseToolArgumentDocPath(rawFilePath);
  if ("errorResult" in parsedFilePath) return parsedFilePath.errorResult;

  return deleteDocumentViaProposal(parsedFilePath.docPath, ctx);
};

// ─── move_file ───────────────────────────────────────────

const moveFileHandler: ToolHandler = async (args, ctx) => {
  const rawSource = args.source as string | undefined;
  const rawDestination = args.destination as string | undefined;

  if (!rawSource) return makeToolErrorResult("Missing required parameter: source");
  if (!rawDestination) return makeToolErrorResult("Missing required parameter: destination");

  const parsedSource = parseToolArgumentDocPath(rawSource);
  if ("errorResult" in parsedSource) return parsedSource.errorResult;
  const parsedDestination = parseToolArgumentDocPath(rawDestination);
  if ("errorResult" in parsedDestination) return parsedDestination.errorResult;
  const source = parsedSource.docPath;
  const destination = parsedDestination.docPath;

  const writer = ctx.writer;

  // Check permissions: read on source, write on both source (to delete) and destination
  const sourceReadOk = await checkDocPermission(writer, source, "read");
  if (!sourceReadOk) {
    return makeToolErrorResult(`Permission denied: you do not have read access to "${source}".`);
  }
  const sourceWriteOk = await checkDocPermission(writer, source, "write");
  if (!sourceWriteOk) {
    return makeToolErrorResult(`Permission denied: you do not have write access to "${source}".`);
  }
  const destWriteOk = await checkDocPermission(writer, destination, "write");
  if (!destWriteOk) {
    return makeToolErrorResult(`Permission denied: you do not have write access to "${destination}".`);
  }

  // Verify source exists
  if (!(await canonicalDocumentExists(source))) {
    return makeToolErrorResult(`Source document not found: ${source}`);
  }

  // Auto-withdraw this session's remembered draft (session-local memory only —
  // another session's draft under the same credential is never touched).
  const existing = await takeCurrentSessionDraft(ctx.session, writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by move");
  }

  const intent = ctx.session.pendingIntent ?? `Move ${source} → ${destination}`;
  ctx.session.pendingIntent = undefined;

  const { id: moveProposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
    undefined,
  );

  // Rename the document inside the proposal through the single manifest-owning
  // boundary: copies the effective source document to the destination and
  // tombstones the source, deriving the manifest from both the source (delete)
  // and destination (write) heading paths so contention is evaluated on both.
  const { manifest } = await mutateProposalContent(moveProposalId, {
    kind: "rename_document",
    docPath: source,
    newPath: destination,
  });

  // Agent write policy gate
  const policyResult = await evaluateAgentWritePolicy(moveProposalId);

  if (policyResult.canWrite) {
    const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);
    const committedHead = await publishProposalToCanonical(moveProposalId, committedMetadata);

    if (ctx.emitEvent) {
      emitContentCommittedEventsByDoc(ctx.emitEvent, writer, [writer.id], committedHead, manifest.targets);
      emitCatalogMutationEvents(
        ctx.emitEvent,
        {
          catalogChanged: true,
          createdDocPaths: [destination],
          deletedDocPaths: [source],
          renamed: { oldPath: source, newPath: destination },
        },
        writer,
        committedHead,
      );
    }

    return jsonToolResult({
      success: true,
      source,
      destination,
      committed_head: committedHead,
      proposal_id: moveProposalId,
      status: "committed",
    });
  } else {
    // Blocked: park the transient as a durable draft (pending/ is discarded on
    // restart) and remember it so this session's next write auto-withdraws it.
    await demoteTransientProposalToDraft(moveProposalId);
    rememberSessionDraft(ctx.session, moveProposalId);
    return jsonBlockedToolResult(policyResult.message, {
      success: false,
      proposal_id: moveProposalId,
      status: "draft",
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  }
};

// ─── apply_patch (unified-diff write) ────────────────────
//
// Replaces the dropped REST `PATCH /documents/:docPath` route. Like every write
// tool it edits a proposal and commits through the agent-write-policy pipeline;
// it never touches canonical directly. The diff is applied to the current
// assembled document, then the patched whole-document payload is written via the
// shared auto-proposal path.

const applyPatchHandler: ToolHandler = async (args, ctx) => {
  const rawFilePath = args.path as string | undefined;
  const diffText = args.diff as string | undefined;

  if (!rawFilePath) return makeToolErrorResult("Missing required parameter: path");
  if (diffText === undefined) return makeToolErrorResult("Missing required parameter: diff");

  const parsedFilePath = parseToolArgumentDocPath(rawFilePath);
  if ("errorResult" in parsedFilePath) return parsedFilePath.errorResult;
  const filePath = parsedFilePath.docPath;

  const writeAllowed = await checkDocPermission(ctx.writer, filePath, "write");
  if (!writeAllowed) {
    return makeToolErrorResult(`Permission denied: you do not have write access to "${filePath}".`);
  }

  let currentContent: string;
  try {
    currentContent = await readAssembledDocument(await authorizeDocRead(ctx.writer, filePath));
  } catch (error) {
    if (error instanceof PermissionError) {
      return makeToolErrorResult(`Permission denied: you do not have read access to "${filePath}".`);
    }
    if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Document not found: ${filePath}`);
    }
    throw error;
  }

  let patchedContent: string;
  try {
    patchedContent = applyUnifiedDiff(currentContent, diffText);
  } catch (error) {
    if (error instanceof DiffParseError || error instanceof DiffApplyError) {
      return makeToolErrorResult(error.stack || error.message);
    }
    throw error;
  }

  if (patchedContent === currentContent) {
    return jsonToolResult({ success: true, doc_path: filePath, no_changes: true });
  }

  return writeDocumentViaProposal([{ path: filePath, content: patchedContent }], ctx);
};

// ─── plan_changes (Tier 2) ───────────────────────────────

const planChangesHandler: ToolHandler = async (args, ctx) => {
  const description = args.description as string | undefined;
  if (!description) return makeToolErrorResult("Missing required parameter: description");

  ctx.session.pendingIntent = description;
  return textToolResult("Intent recorded. It will be attached to your next write.");
};

// ─── Shared: write via auto-proposal ─────────────────────

async function writeDocumentViaProposal(
  files: Array<{ path: DocPath; content: string }>,
  ctx: import("../tool-registry.js").ToolContext,
): Promise<import("../protocol.js").McpToolCallResult> {
  const writer = ctx.writer;
  const createdDocPaths: DocPath[] = [];

  // Check write permission for all target documents
  for (const file of files) {
    const allowed = await checkDocPermission(writer, file.path, "write");
    if (!allowed) {
      return makeToolErrorResult(`Permission denied: you do not have write access to "${file.path}".`);
    }
  }

  // Consume pending intent from plan_changes (Tier 2), or use default
  const intent = ctx.session.pendingIntent ?? `Write ${files.map((f) => f.path).join(", ")}`;
  ctx.session.pendingIntent = undefined;

  // Pre-check which docs are new so catalog:changed reports created paths.
  for (const file of files) {
    if (!(await canonicalDocumentExists(file.path))) {
      createdDocPaths.push(file.path);
    }
  }

  // Auto-withdraw this session's remembered draft (session-local memory only —
  // another session's draft under the same credential is never touched).
  const existing = await takeCurrentSessionDraft(ctx.session, writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by new write");
  }

  // Create proposal (sections updated after write)
  const { id: writeProposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
    undefined,
  );

  // Write each whole-document payload + derive the manifest from the normalized
  // on-disk heading structure through the single manifest-owning boundary.
  const { manifest: allSectionTargets } = await mutateProposalContent(writeProposalId, {
    kind: "write_document_markdown",
    files: files.map((f) => ({ docPath: f.path, markdown: f.content })),
  });

  const policyResult = await evaluateAgentWritePolicy(writeProposalId);

  if (policyResult.canWrite) {
    const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);

    const absorbResult = await publishProposalToCanonicalDetailed(writeProposalId, committedMetadata);
    const committedHead = absorbResult.commitSha;

    await propagateCommitToLiveSessions(absorbResult, writeProposalId);

    // Broadcast content:committed
    if (ctx.emitEvent) {
      emitContentCommittedEventsByDoc(ctx.emitEvent, writer, [writer.id], committedHead, allSectionTargets.targets);
      emitCatalogMutationEvents(
        ctx.emitEvent,
        {
          catalogChanged: createdDocPaths.length > 0,
          createdDocPaths,
          deletedDocPaths: [],
          renamed: null,
        },
        writer,
      );
    }

    const normalizationNote = AgentPayloadContract.noteForNormalizedWrite(
      files.map((f) => f.content),
      "read_file",
    );

    return jsonToolResult({
      success: true,
      committed_head: committedHead,
      proposal_id: writeProposalId,
      status: "committed",
      ...(normalizationNote ? { normalization_note: normalizationNote } : {}),
    });
  } else {
    // Blocked: park the transient as a durable draft (pending/ is discarded on
    // restart) and remember it so this session's next write auto-withdraws it.
    await demoteTransientProposalToDraft(writeProposalId);
    rememberSessionDraft(ctx.session, writeProposalId);
    // Hoist the policy's prose explanation to a top-level message
    // (Area M: top-level prose + per-target prose, no codes/enums).
    return jsonBlockedToolResult(policyResult.message, {
      success: false,
      proposal_id: writeProposalId,
      status: "draft",
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  }
}

// ─── Shared: delete document via proposal ────────────────

async function deleteDocumentViaProposal(
  docPath: DocPath,
  ctx: import("../tool-registry.js").ToolContext,
): Promise<import("../protocol.js").McpToolCallResult> {
  const writer = ctx.writer;

  const deleteAllowed = await checkDocPermission(writer, docPath, "write");
  if (!deleteAllowed) {
    return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);
  }

  // Verify document exists in canonical
  if (!(await canonicalDocumentExists(docPath))) {
    return makeToolErrorResult(`Document not found: ${docPath}`);
  }

  // NOTE: no DocSession topology precondition here — MCP filesystem writes
  // stage proposal content only. Topology safety (an active live editing
  // session on this document) is enforced at the publish/commit boundary by
  // the DocSession actor's publish-or-abort / invalidation policy (Areas B/C/F),
  // not by blocking the staged proposal write.

  // Auto-withdraw this session's remembered draft (session-local memory only —
  // another session's draft under the same credential is never touched).
  const existing = await takeCurrentSessionDraft(ctx.session, writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by new delete");
  }

  // Create proposal (sections updated after tombstone reads canonical headings)
  const { id: delProposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Delete document: ${docPath}`,
    undefined,
  );

  // Tombstone the document + derive the manifest from the real canonical heading
  // paths going away, through the single manifest-owning boundary.
  const { manifest } = await mutateProposalContent(delProposalId, {
    kind: "delete_document",
    docPath,
  });

  // Agent write policy gate
  const policyResult = await evaluateAgentWritePolicy(delProposalId);

  if (policyResult.canWrite) {
    const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);
    const committedHead = await publishProposalToCanonical(delProposalId, committedMetadata);

    if (ctx.emitEvent) {
      emitContentCommittedEventsByDoc(ctx.emitEvent, writer, [writer.id], committedHead, manifest.targets);
      emitCatalogMutationEvents(
        ctx.emitEvent,
        {
          catalogChanged: true,
          createdDocPaths: [],
          deletedDocPaths: [docPath],
          renamed: null,
        },
        writer,
      );
    }

    return jsonToolResult({
      success: true,
      doc_path: docPath,
      deleted: true,
      committed_head: committedHead,
      proposal_id: delProposalId,
      status: "committed",
    });
  } else {
    // Blocked: park the transient as a durable draft (pending/ is discarded on
    // restart) and remember it so this session's next write auto-withdraws it.
    await demoteTransientProposalToDraft(delProposalId);
    rememberSessionDraft(ctx.session, delProposalId);
    return jsonBlockedToolResult(policyResult.message, {
      success: false,
      proposal_id: delProposalId,
      status: "draft",
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  }
}

// ─── Registration ────────────────────────────────────────

export function registerFilesystemTools(registry: ToolRegistry): void {
  registry.register(
    "readFile",
    {
      name: "read_file",
      description: "Read a document from the Knowledge Store. The response IS the full assembled raw markdown — no JSON envelope.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Logical document path (e.g. 'ops/sales/strategy.md')" },
        },
        required: ["path"],
      },
    },
    readFileHandler,
  );

  registry.register(
    "writeFile",
    {
      name: "write_file",
      description: "Write content to a document. The write goes through the proposal system — it may be accepted immediately, or blocked when the active agent write policy declines (e.g. recent human involvement) or another proposal holds an exclusive lock on a target section. A blocked result includes a prose message and per-target explanations describing what clears the block.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Logical document path" },
          content: { type: "string", description: "Full markdown content to write. The value is markdown containing the real characters the section should read as; a \\uXXXX escape sequence in prose is refused — write escape sequences inside inline code or a fenced code block." },
        },
        required: ["path", "content"],
      },
    },
    writeFileHandler,
  );

  registry.register(
    "writeFiles",
    {
      name: "write_files",
      description: "Write multiple documents as one coordinated change. All files are submitted as a single proposal so they succeed or fail together.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Logical document path" },
                content: { type: "string", description: "Full markdown content. The value is markdown containing the real characters the section should read as; a \\uXXXX escape sequence in prose is refused — write escape sequences inside inline code or a fenced code block." },
              },
              required: ["path", "content"],
            },
            description: "Array of files to write",
          },
        },
        required: ["files"],
      },
    },
    writeFilesHandler,
  );

  registry.register(
    "listDirectory",
    {
      name: "list_directory",
      description: "List documents and directories in the Knowledge Store. Returns a tree of entries with name, path, and type.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to list (empty string for root)" },
        },
      },
    },
    listDirectoryHandler,
  );

  registry.register(
    "deleteFile",
    {
      name: "delete_file",
      description: "Delete a document from the Knowledge Store.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Logical document path to delete" },
        },
        required: ["path"],
      },
    },
    deleteFileHandler,
  );

  registry.register(
    "moveFile",
    {
      name: "move_file",
      description: "Move/rename a document in the Knowledge Store.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Current document path" },
          destination: { type: "string", description: "New document path" },
        },
        required: ["source", "destination"],
      },
    },
    moveFileHandler,
  );

  registry.register(
    "applyPatch",
    {
      name: "apply_patch",
      description: "Apply a unified diff to a document. The diff is applied to the current assembled markdown, then written through the proposal system — it may be accepted immediately, or blocked when the active agent write policy declines or another proposal holds an exclusive lock on a target section. A blocked result includes a prose message and per-target explanations. If the diff produces no change, the result reports no_changes.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Logical document path (e.g. 'ops/sales/strategy.md')" },
          diff: { type: "string", description: "Unified diff to apply to the document's current content" },
        },
        required: ["path", "diff"],
      },
    },
    applyPatchHandler,
  );
}

export function registerPlanChangesTool(registry: ToolRegistry): void {
  registry.register(
    "planChanges",
    {
      name: "plan_changes",
      description: "Declare intent before writing (Tier 2). Sets a human-readable description of what you are about to change. The description is attached to the next write_file or write_files call.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "What you plan to change and why" },
        },
        required: ["description"],
      },
    },
    planChangesHandler,
  );
}
