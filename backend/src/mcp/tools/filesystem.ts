/**
 * Tier 1 + Tier 2 MCP tools — filesystem-compatible surface.
 *
 * Tools: read_file, write_file, write_files, list_directory,
 *        delete_file, move_file, plan_changes
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult, textToolResult, jsonBlockedToolResult } from "../tool-registry.js";
import { makeToolErrorResult } from "../protocol.js";
import { readAssembledDocument, DocumentNotFoundError } from "../../storage/document-reader.js";
import { readDocumentsTree } from "../../storage/documents-tree.js";
import { getContentRoot, getDataRoot } from "../../storage/data-root.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { readDocumentStructure, flattenStructureToHeadingPaths } from "../../storage/heading-resolver.js";
import {
  createTransientProposal,
  findDraftProposalByWriter,
  transitionToWithdrawn,
} from "../../storage/proposal-repository.js";
import { resolveDocPathUnderContent, InvalidDocPathError } from "../../storage/path-utils.js";
import { access } from "node:fs/promises";
import {
  evaluateAgentWritePolicy,
  commitProposalToCanonical,
  commitProposalToCanonicalDetailed,
} from "../../storage/commit-pipeline.js";
import { applyCommittedCanonicalToLiveSession } from "../../ws/crdt-ws-coordinator.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { agentWritePolicyToolBody } from "./agent-write-policy-body.js";
import { checkDocPermission } from "../../auth/acl.js";
import { canonicalDocumentExists, emitCatalogMutationEvents } from "../catalog-events.js";

// ─── read_file ───────────────────────────────────────────

const readFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = args.path as string | undefined;
  if (!filePath) {
    return makeToolErrorResult("Missing required parameter: path");
  }

  const readAllowed = await checkDocPermission(ctx.writer, filePath, "read");
  if (!readAllowed) {
    return makeToolErrorResult(`Permission denied: you do not have read access to "${filePath}".`);
  }

  try {
    const content = await readAssembledDocument(filePath);
    const headSha = await getHeadSha(getDataRoot());

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

    return jsonToolResult({ content, head_sha: headSha });
  } catch (error) {
    if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Document not found: ${filePath}`);
    }
    throw error;
  }
};

// ─── write_file ──────────────────────────────────────────

const writeFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = args.path as string | undefined;
  const content = args.content as string | undefined;

  if (!filePath) return makeToolErrorResult("Missing required parameter: path");
  if (content === undefined) return makeToolErrorResult("Missing required parameter: content");

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

  for (const file of files) {
    if (!file.path || file.content === undefined) {
      return makeToolErrorResult("Each file must have path and content");
    }
  }

  return writeDocumentViaProposal(files, ctx);
};

// ─── list_directory ──────────────────────────────────────

const listDirectoryHandler: ToolHandler = async (args) => {
  const dirPath = (args.path as string | undefined) ?? "";

  try {
    const tree = await readDocumentsTree(dirPath);
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
  const filePath = args.path as string | undefined;
  if (!filePath) return makeToolErrorResult("Missing required parameter: path");

  return deleteDocumentViaProposal(filePath, ctx);
};

// ─── move_file ───────────────────────────────────────────

const moveFileHandler: ToolHandler = async (args, ctx) => {
  const source = args.source as string | undefined;
  const destination = args.destination as string | undefined;

  if (!source) return makeToolErrorResult("Missing required parameter: source");
  if (!destination) return makeToolErrorResult("Missing required parameter: destination");

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

  const canonicalContentRoot = getContentRoot();

  // Verify source exists
  try {
    resolveDocPathUnderContent(canonicalContentRoot, source);
    await access(resolveDocPathUnderContent(canonicalContentRoot, source));
  } catch {
    return makeToolErrorResult(`Source document not found: ${source}`);
  }

  // Auto-withdraw any existing pending proposal
  const existing = await findDraftProposalByWriter(writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by move");
  }

  const intent = ctx.session.pendingIntent ?? `Move ${source} → ${destination}`;
  ctx.session.pendingIntent = undefined;

  const { id: moveProposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
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
  const proposalSections: Array<{ doc_path: string; heading_path: string[] }> = manifest.sections;

  // Agent write policy gate
  const policyResult = await evaluateAgentWritePolicy(moveProposalId);

  if (policyResult.canWrite) {
    const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);
    const committedHead = await commitProposalToCanonical(moveProposalId, committedMetadata);

    if (ctx.emitEvent) {
      ctx.emitEvent({
        type: "content:committed",
        doc_path: destination,
        sections: proposalSections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
        commit_sha: committedHead,
        writer_id: writer.id,
        writer_display_name: writer.displayName,
        writer_type: writer.type,
        contributor_ids: [writer.id],
        seconds_ago: 0,
      });
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
    return jsonBlockedToolResult(policyResult.message, {
      success: false,
      proposal_id: moveProposalId,
      status: "draft",
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  }
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
  files: Array<{ path: string; content: string }>,
  ctx: import("../tool-registry.js").ToolContext,
): Promise<import("../protocol.js").McpToolCallResult> {
  const writer = ctx.writer;
  const createdDocPaths: string[] = [];

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

  // Check for existing pending proposal and auto-withdraw
  const existing = await findDraftProposalByWriter(writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by new write");
  }

  // Create proposal (sections updated after write)
  const { id: writeProposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
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

    const absorbResult = await commitProposalToCanonicalDetailed(writeProposalId, committedMetadata);
    const committedHead = absorbResult.commitSha;

    // MW-3: push the committed canonical change into any open live DocSession
    // for the affected docs (canonical→live; the coordinator skips a self-commit).
    {
      const byDoc = new Map<string, string[][]>();
      for (const ref of absorbResult.changedSections) {
        if (!byDoc.has(ref.docPath)) byDoc.set(ref.docPath, []);
        byDoc.get(ref.docPath)!.push([...ref.headingPath]);
      }
      for (const [docPath, headingPaths] of byDoc) {
        await applyCommittedCanonicalToLiveSession(docPath, headingPaths, writeProposalId);
      }
    }

    // Broadcast content:committed
    if (ctx.emitEvent) {
      ctx.emitEvent({
        type: "content:committed",
        doc_path: allSectionTargets.sections[0]?.doc_path ?? files[0]?.path ?? "",
        sections: allSectionTargets.sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
        commit_sha: committedHead,
        writer_id: writer.id,
        writer_display_name: writer.displayName,
        writer_type: writer.type,
        contributor_ids: [writer.id],
        seconds_ago: 0,
      });
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

    return jsonToolResult({
      success: true,
      committed_head: committedHead,
      proposal_id: writeProposalId,
      status: "committed",
    });
  } else {
    // Blocked — hoist the policy's prose explanation to a top-level message
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
  docPath: string,
  ctx: import("../tool-registry.js").ToolContext,
): Promise<import("../protocol.js").McpToolCallResult> {
  const writer = ctx.writer;

  const deleteAllowed = await checkDocPermission(writer, docPath, "write");
  if (!deleteAllowed) {
    return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);
  }

  const canonicalContentRoot = getContentRoot();

  // Verify document exists in canonical
  let resolvedPath: string;
  try {
    resolvedPath = resolveDocPathUnderContent(canonicalContentRoot, docPath);
  } catch {
    return makeToolErrorResult(`Invalid document path: ${docPath}`);
  }
  try {
    await access(resolvedPath);
  } catch {
    return makeToolErrorResult(`Document not found: ${docPath}`);
  }

  // NOTE: no DocSession topology precondition here — MCP filesystem writes
  // stage proposal content only. Topology safety (an active live editing
  // session on this document) is enforced at the publish/commit boundary by
  // the DocSession actor's publish-or-abort / invalidation policy (Areas B/C/F),
  // not by blocking the staged proposal write.

  // Auto-withdraw any existing pending proposal by this writer
  const existing = await findDraftProposalByWriter(writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by new delete");
  }

  // Create proposal (sections updated after tombstone reads canonical headings)
  const { id: delProposalId } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Delete document: ${docPath}`,
  );

  // Tombstone the document + derive the manifest from the real canonical heading
  // paths going away, through the single manifest-owning boundary.
  const { manifest } = await mutateProposalContent(delProposalId, {
    kind: "delete_document",
    docPath,
  });
  const proposalSections: Array<{ doc_path: string; heading_path: string[] }> = manifest.sections;

  // Agent write policy gate
  const policyResult = await evaluateAgentWritePolicy(delProposalId);

  if (policyResult.canWrite) {
    const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);
    const committedHead = await commitProposalToCanonical(delProposalId, committedMetadata);

    if (ctx.emitEvent) {
      ctx.emitEvent({
        type: "content:committed",
        doc_path: docPath,
        sections: proposalSections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
        commit_sha: committedHead,
        writer_id: writer.id,
        writer_display_name: writer.displayName,
        writer_type: writer.type,
        contributor_ids: [writer.id],
        seconds_ago: 0,
      });
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
    {
      name: "read_file",
      description: "Read a document from the Knowledge Store. Returns the full assembled markdown content.",
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
    {
      name: "write_file",
      description: "Write content to a document. The write goes through the proposal system — it may be accepted immediately, or blocked when the active agent write policy declines (e.g. recent human involvement) or another proposal holds an exclusive lock on a target section. A blocked result includes a prose message and per-target explanations describing what clears the block.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Logical document path" },
          content: { type: "string", description: "Full markdown content to write" },
        },
        required: ["path", "content"],
      },
    },
    writeFileHandler,
  );

  registry.register(
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
                content: { type: "string", description: "Full markdown content" },
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

}

export function registerPlanChangesTool(registry: ToolRegistry): void {
  registry.register(
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
