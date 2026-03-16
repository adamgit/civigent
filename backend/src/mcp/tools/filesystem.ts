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
import { ContentLayer } from "../../storage/content-layer.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { readDocumentStructure, flattenStructureToHeadingPaths } from "../../storage/heading-resolver.js";
import {
  createProposal,
  findPendingProposalByWriter,
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
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import type { SectionScoreSnapshot } from "../../types/shared.js";

// ─── read_file ───────────────────────────────────────────

const readFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = args.path as string | undefined;
  if (!filePath) {
    return makeToolErrorResult("Missing required parameter: path");
  }

  try {
    const content = await readAssembledDocument(filePath);
    const headSha = await getHeadSha(getDataRoot());

    // Broadcast agent:reading
    if (ctx.writer.type === "agent" && ctx.emitEvent) {
      const structure = await readDocumentStructure(filePath).catch(() => []);
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
  const canonicalContentRoot = getContentRoot();

  // Verify source exists
  try {
    resolveDocPathUnderContent(canonicalContentRoot, source);
    await access(resolveDocPathUnderContent(canonicalContentRoot, source));
  } catch {
    return makeToolErrorResult(`Source document not found: ${source}`);
  }

  // Load source skeleton and collect all sections with body content
  const sourceSkeleton = await DocumentSkeleton.fromDisk(source, canonicalContentRoot, canonicalContentRoot);
  if (sourceSkeleton.isEmpty) {
    return makeToolErrorResult(`Source document not found: ${source}`);
  }
  const subtree = await sourceSkeleton.collectSubtree([]);
  const headingPaths: string[][] = [];
  sourceSkeleton.forEachSection((_h, _l, _sf, hp, _ap, isSub) => {
    if (!isSub) headingPaths.push([...hp]);
  });

  // Auto-withdraw any existing pending proposal
  const existing = await findPendingProposalByWriter(writer.id);
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

  const { proposal, contentRoot } = await createProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
    proposalSections,
  );

  // Write tombstone at source path
  const tombstone = DocumentSkeleton.createTombstone(source, contentRoot, canonicalContentRoot);
  await tombstone.persist();

  // Copy content to destination path using skeleton API
  const destSkeleton = DocumentSkeleton.createEmpty(destination, contentRoot);
  for (const entry of subtree) {
    if (entry.headingPath.length === 0) continue; // root handled by createEmpty
    destSkeleton.insertSectionUnder(entry.headingPath.slice(0, -1), {
      heading: entry.heading,
      level: entry.level,
      body: entry.bodyContent,
    });
  }
  await destSkeleton.persist();

  // Write body files to proposal overlay
  const destContentLayer = new ContentLayer(contentRoot);
  for (const entry of subtree) {
    await destContentLayer.writeSection(
      new SectionRef(destination, entry.headingPath),
      entry.bodyContent,
    );
  }

  // Evaluate human involvement
  const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal);

  if (evaluation.all_sections_accepted) {
    const scores: import("../../types/shared.js").SectionScoreSnapshot = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }
    const committedHead = await commitProposalToCanonical(proposal, scores);

    if (ctx.emitEvent) {
      ctx.emitEvent({
        type: "content:committed",
        doc_path: destination,
        sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
        commit_sha: committedHead,
        source: "agent_proposal",
        writer_id: writer.id,
        writer_display_name: writer.displayName,
      });
    }

    return jsonToolResult({
      success: true,
      source,
      destination,
      committed_head: committedHead,
      proposal_id: proposal.id,
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
      proposal_id: proposal.id,
      status: "pending",
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

  // Consume pending intent from plan_changes (Tier 2), or use default
  const intent = ctx.session.pendingIntent ?? `Write ${files.map((f) => f.path).join(", ")}`;
  ctx.session.pendingIntent = undefined;

  // Build proposal sections (metadata) and content separately
  const proposalSections: Array<{
    doc_path: string;
    heading_path: string[];
    justification?: string;
  }> = [];
  const sectionContents: Array<{
    doc_path: string;
    heading_path: string[];
    content: string;
  }> = [];

  for (const file of files) {
    // All files written as root section (single section or overwrite)
    proposalSections.push({
      doc_path: file.path,
      heading_path: [],
    });
    sectionContents.push({
      doc_path: file.path,
      heading_path: [],
      content: file.content,
    });
  }

  // Check for existing pending proposal and auto-withdraw
  const existing = await findPendingProposalByWriter(writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by new write");
  }

  // Create and immediately evaluate proposal
  const { proposal, contentRoot } = await createProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
    proposalSections,
  );

  // Ensure skeletons exist for new documents in the proposal's content overlay.
  // For existing documents, the canonical fallback provides the skeleton.
  const canonicalContentRoot = getContentRoot();
  const seenDocPaths = new Set<string>();
  for (const sc of sectionContents) {
    if (seenDocPaths.has(sc.doc_path)) continue;
    seenDocPaths.add(sc.doc_path);

    // Check if skeleton exists in canonical
    const canonicalSkeleton = await DocumentSkeleton.fromDisk(
      sc.doc_path, canonicalContentRoot, canonicalContentRoot,
    );

    if (canonicalSkeleton.isEmpty) {
      // New document — create skeleton in the proposal's content overlay
      const skeleton = DocumentSkeleton.createEmpty(sc.doc_path, contentRoot);
      await skeleton.persist();
    }
  }

  // Write section content to proposal's content directory.
  // Use canonical fallback so readSkeleton finds existing skeletons.
  const fContentLayer = new ContentLayer(contentRoot, new ContentLayer(canonicalContentRoot));
  for (const sc of sectionContents) {
    await fContentLayer.writeSection(new SectionRef(sc.doc_path, sc.heading_path), sc.content);
  }

  const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal);

  if (evaluation.all_sections_accepted) {
    const scores: SectionScoreSnapshot = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }

    const committedHead = await commitProposalToCanonical(proposal, scores);

    // Broadcast content:committed
    if (ctx.emitEvent) {
      ctx.emitEvent({
        type: "content:committed",
        doc_path: sections[0]?.doc_path ?? "",
        sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
        commit_sha: committedHead,
        source: "agent_proposal",
        writer_id: writer.id,
        writer_display_name: writer.displayName,
      });
    }

    return jsonToolResult({
      success: true,
      committed_head: committedHead,
      proposal_id: proposal.id,
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
      proposal_id: proposal.id,
      status: "pending",
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

  // Load canonical skeleton to get all sections for human-involvement evaluation
  const skeleton = await DocumentSkeleton.fromDisk(docPath, canonicalContentRoot, canonicalContentRoot);
  const headingPaths: string[][] = [];
  skeleton.forEachSection((_heading, _level, _sectionFile, headingPath, _absolutePath, isSubSkeleton) => {
    if (!isSubSkeleton) headingPaths.push([...headingPath]);
  });

  // Auto-withdraw any existing pending proposal by this writer
  const existing = await findPendingProposalByWriter(writer.id);
  if (existing) {
    await transitionToWithdrawn(existing.id, "auto-withdrawn by new delete");
  }

  // Create proposal with all sections as targets
  const proposalSections = headingPaths.map((hp) => ({
    doc_path: docPath,
    heading_path: hp,
  }));

  const { proposal, contentRoot } = await createProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    `Delete document: ${docPath}`,
    proposalSections,
  );

  // Write tombstone skeleton to proposal overlay
  const tombstone = DocumentSkeleton.createTombstone(docPath, contentRoot, canonicalContentRoot);
  await tombstone.persist();

  // Evaluate human involvement
  const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal);

  if (evaluation.all_sections_accepted) {
    const scores: import("../../types/shared.js").SectionScoreSnapshot = {};
    for (const s of sections) {
      scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
    }
    const committedHead = await commitProposalToCanonical(proposal, scores);

    if (ctx.emitEvent) {
      ctx.emitEvent({
        type: "content:committed",
        doc_path: docPath,
        sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
        commit_sha: committedHead,
        source: "agent_proposal",
        writer_id: writer.id,
        writer_display_name: writer.displayName,
      });
    }

    return jsonToolResult({
      success: true,
      doc_path: docPath,
      deleted: true,
      committed_head: committedHead,
      proposal_id: proposal.id,
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
      proposal_id: proposal.id,
      status: "pending",
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
