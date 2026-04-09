/**
 * Tier 1 + Tier 2 MCP tools — filesystem-compatible surface.
 *
 * Tools: read_file, write_file, write_files, list_directory,
 *        delete_file, move_file, plan_changes
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult, textToolResult } from "../tool-registry.js";
import { makeToolErrorResult } from "../protocol.js";
import { readAssembledDocument, DocumentNotFoundError } from "../../storage/document-reader.js";
import { readDocumentsTree } from "../../storage/documents-tree.js";
import { getContentRoot, getDataRoot } from "../../storage/data-root.js";
import { ContentLayer, OverlayContentLayer } from "../../storage/content-layer.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { readDocumentStructure, flattenStructureToHeadingPaths } from "../../storage/heading-resolver.js";
import {
  createTransientProposal,
  findDraftProposalByWriter,
  transitionToWithdrawn,
} from "../../storage/proposal-repository.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import { resolveDocPathUnderContent, InvalidDocPathError } from "../../storage/path-utils.js";
import { access } from "node:fs/promises";
import {
  evaluateProposalHumanInvolvement,
  commitProposalToCanonical,
} from "../../storage/commit-pipeline.js";
import { SectionRef } from "../../domain/section-ref.js";
import type { SectionScoreSnapshot } from "../../types/shared.js";
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

  // Load source heading paths for proposal metadata.
  // A live-empty doc (zero sections) is valid — don't conflate zero headings with "not found".
  const canonicalLayer = new ContentLayer(canonicalContentRoot);
  const headingPaths = await canonicalLayer.listHeadingPaths(source);

  // Auto-withdraw any existing pending proposal
  const existing = await findDraftProposalByWriter(writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by move");
  }

  // Create proposal covering both source (delete) and destination (write) sections
  const proposalSections = [
    ...headingPaths.map((hp) => ({ doc_path: source, heading_path: hp })),
    ...headingPaths.map((hp) => ({ doc_path: destination, heading_path: hp })),
  ];

  const intent = ctx.session.pendingIntent ?? `Move ${source} → ${destination}`;
  ctx.session.pendingIntent = undefined;

  const { id: moveProposalId, contentRoot } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
    proposalSections,
  );

  // Write tombstone at source path in the proposal overlay
  const moveOverlayLayer = new OverlayContentLayer(contentRoot, canonicalContentRoot);
  await moveOverlayLayer.tombstoneDocumentExplicit(source);

  // Stage destination by copying canonical skeleton/body files into overlay.
  await moveOverlayLayer.copyCanonicalDocumentToOverlay(source, destination);

  // Evaluate human involvement
  const { evaluation, sections } = await evaluateProposalHumanInvolvement(moveProposalId);

  if (evaluation.all_sections_accepted) {
    const scores: import("../../types/shared.js").SectionScoreSnapshot = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }
    const committedHead = await commitProposalToCanonical(moveProposalId, scores);

    if (ctx.emitEvent) {
      ctx.emitEvent({
        type: "content:committed",
        doc_path: destination,
        sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
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
    const blockedSections = sections
      .filter((s) => s.blocked)
      .map((s) => ({
        doc_path: s.doc_path,
        heading_path: s.heading_path,
        humanInvolvement_score: s.humanInvolvement_score,
      }));

    return jsonToolResult({
      success: false,
      proposal_id: moveProposalId,
      status: "draft",
      outcome: "blocked",
      blocked_sections: blockedSections,
      message: "Some sections are contested by human editors. The move proposal has been saved as pending.",
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

  // Pre-parse all files to build proposal sections from actual heading structure
  // (not hardcoded to root). This normalizes multi-section markdown.
  const canonicalContentRoot = getContentRoot();
  const allSectionTargets: Array<{
    doc_path: string;
    heading_path: string[];
  }> = [];

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
  const { id: writeProposalId, contentRoot } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
  );

  // Write each file through upsertDocumentFromMarkdown (clear/create to
  // live-empty, then root-target upsert), then read back the resulting
  // heading paths via listHeadingPaths to build proposal section metadata.
  // The storage primitive returns nothing — proposal metadata derivation
  // lives here at the MCP-tool layer.
  const fContentLayer = new OverlayContentLayer(contentRoot, canonicalContentRoot);
  for (const file of files) {
    await fContentLayer.upsertDocumentFromMarkdown(file.path, file.content);
    const headingPaths = await fContentLayer.listHeadingPaths(file.path);
    for (const hp of headingPaths) {
      allSectionTargets.push({ doc_path: file.path, heading_path: hp });
    }
  }

  // Update proposal sections to match the actual normalized structure
  const { updateProposalSections } = await import("../../storage/proposal-repository.js");
  await updateProposalSections(writeProposalId, allSectionTargets);

  const { evaluation, sections } = await evaluateProposalHumanInvolvement(writeProposalId);

  if (evaluation.all_sections_accepted) {
    const scores: SectionScoreSnapshot = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }

    const committedHead = await commitProposalToCanonical(writeProposalId, scores);

    // Broadcast content:committed
    if (ctx.emitEvent) {
      ctx.emitEvent({
        type: "content:committed",
        doc_path: sections[0]?.doc_path ?? files[0]?.path ?? "",
        sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
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
    // Blocked — return details about which sections are blocked and why
    const blockedSections = sections
      .filter((s) => s.blocked)
      .map((s) => ({
        doc_path: s.doc_path,
        heading_path: s.heading_path,
        humanInvolvement_score: s.humanInvolvement_score,
      }));

    return jsonToolResult({
      success: false,
      proposal_id: writeProposalId,
      status: "draft",
      outcome: "blocked",
      blocked_sections: blockedSections,
      message: "Some sections are contested by human editors. The proposal has been saved as pending. You can modify it via the proposal API or wait for the contention to resolve.",
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

  // Check for active CRDT sessions
  const docSession = lookupDocSession(docPath);
  if (docSession) {
    return makeToolErrorResult("Cannot delete document with active editing session.");
  }

  // Auto-withdraw any existing pending proposal by this writer
  const existing = await findDraftProposalByWriter(writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by new delete");
  }

  // Create proposal (sections updated after tombstone reads canonical headings)
  const { id: delProposalId, contentRoot } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Delete document: ${docPath}`,
  );

  // Read canonical headings and write a tombstone marker to the proposal overlay
  const delOverlayLayer = new OverlayContentLayer(contentRoot, canonicalContentRoot);
  const headingPaths = await delOverlayLayer.tombstoneDocument(docPath);

  // Update proposal sections to match the canonical structure
  const proposalSections = headingPaths.map((hp) => ({
    doc_path: docPath,
    heading_path: hp,
  }));
  const { updateProposalSections: updateDelProposalSections } = await import("../../storage/proposal-repository.js");
  await updateDelProposalSections(delProposalId, proposalSections);

  // Evaluate human involvement
  const { evaluation, sections } = await evaluateProposalHumanInvolvement(delProposalId);

  if (evaluation.all_sections_accepted) {
    const scores: import("../../types/shared.js").SectionScoreSnapshot = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }
    const committedHead = await commitProposalToCanonical(delProposalId, scores);

    if (ctx.emitEvent) {
      ctx.emitEvent({
        type: "content:committed",
        doc_path: docPath,
        sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
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
    const blockedSections = sections
      .filter((s) => s.blocked)
      .map((s) => ({
        doc_path: s.doc_path,
        heading_path: s.heading_path,
        humanInvolvement_score: s.humanInvolvement_score,
      }));

    return jsonToolResult({
      success: false,
      proposal_id: delProposalId,
      status: "draft",
      outcome: "blocked",
      blocked_sections: blockedSections,
      message: "Some sections are contested by human editors. The delete proposal has been saved as pending.",
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
      description: "Write content to a document. The write goes through the proposal system — it may be accepted immediately or blocked if a human is actively editing contested sections.",
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
