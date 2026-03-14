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
import { getContentRoot, getDataRoot, getSessionDocsRoot } from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getHeadSha, gitExec } from "../../storage/git-repo.js";
import { readDocumentStructure, flattenStructureToHeadingPaths, resolveAllSectionPaths } from "../../storage/heading-resolver.js";
import { readAllSectionsWithOverlay } from "../../storage/session-store.js";
import {
  createProposal,
  findPendingProposalByWriter,
  listProposals,
  transitionToWithdrawn,
} from "../../storage/proposal-repository.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import { resolveDocPathUnderContent } from "../../storage/path-utils.js";
import { access, rm } from "node:fs/promises";
import {
  evaluateProposalHumanInvolvement,
  commitProposalToCanonical,
} from "../../storage/commit-pipeline.js";
import { SectionRef } from "../../domain/section-ref.js";

import { SectionPresence } from "../../domain/section-presence.js";
import { readDocSectionCommitInfo, type SectionCommitInfo } from "../../storage/section-activity.js";
import { InvalidDocPathError } from "../../storage/path-utils.js";
import type { SectionScoreSnapshot } from "../../types/shared.js";
import path from "node:path";

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

const deleteFileHandler: ToolHandler = async (args) => {
  const filePath = args.path as string | undefined;
  if (!filePath) return makeToolErrorResult("Missing required parameter: path");

  return deleteDocument(filePath);
};

// ─── move_file ───────────────────────────────────────────

const moveFileHandler: ToolHandler = async (args, ctx) => {
  const source = args.source as string | undefined;
  const destination = args.destination as string | undefined;

  if (!source) return makeToolErrorResult("Missing required parameter: source");
  if (!destination) return makeToolErrorResult("Missing required parameter: destination");

  // Read source content
  let content: string;
  try {
    content = await readAssembledDocument(source);
  } catch (error) {
    if (error instanceof DocumentNotFoundError) {
      return makeToolErrorResult(`Source document not found: ${source}`);
    }
    throw error;
  }

  // Write to destination
  const writeResult = await writeDocumentViaProposal(
    [{ path: destination, content }],
    ctx,
  );

  // If write succeeded, delete source
  const resultData = JSON.parse(writeResult.content[0].text);
  if (resultData.success) {
    await deleteDocument(source);
    return jsonToolResult({
      success: true,
      source,
      destination,
      committed_head: resultData.committed_head,
    });
  }

  return writeResult;
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

  // Write section content to proposal's content directory
  const fContentLayer = new ContentLayer(contentRoot);
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

// ─── Shared: delete document ─────────────────────────────

async function deleteDocument(
  docPath: string,
): Promise<import("../protocol.js").McpToolCallResult> {
  const contentRoot = getContentRoot();
  let resolvedPath: string;
  try {
    resolvedPath = resolveDocPathUnderContent(contentRoot, docPath);
  } catch {
    return makeToolErrorResult(`Invalid document path: ${docPath}`);
  }

  // Verify exists
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

  // Check for pending proposals referencing this document
  const pendingProposals = await listProposals("pending");
  const conflicting = pendingProposals.filter((p) =>
    p.sections.some((s) => s.doc_path === docPath),
  );
  if (conflicting.length > 0) {
    return makeToolErrorResult(
      `Cannot delete document referenced by pending proposals: ${conflicting.map((p) => p.id).join(", ")}`,
    );
  }

  // Check for orphaned dirty session files (flushed but not yet committed)
  const sessionDocsContentRoot = path.join(getSessionDocsRoot(), "content");
  try {
    const sessionDocPath = resolveDocPathUnderContent(sessionDocsContentRoot, docPath);
    await access(sessionDocPath);
    // File exists — dirty session files are present
    return makeToolErrorResult("Cannot delete document: uncommitted session files exist.");
  } catch {
    // No dirty session file — also check .sections/ directory
    try {
      const sessionDocPath = resolveDocPathUnderContent(sessionDocsContentRoot, docPath);
      await access(`${sessionDocPath}.sections`);
      return makeToolErrorResult("Cannot delete document: uncommitted session files exist.");
    } catch {
      // No dirty session files — safe to proceed
    }
  }

  // Delete skeleton + sections
  await rm(resolvedPath, { force: true });
  await rm(`${resolvedPath}.sections`, { recursive: true, force: true });

  // Clean up any remaining session artifacts (may not exist — safe to ignore)
  try {
    const sessionDocPath = resolveDocPathUnderContent(sessionDocsContentRoot, docPath);
    await rm(sessionDocPath, { force: true });
    await rm(`${sessionDocPath}.sections`, { recursive: true, force: true });
  } catch {
    // Session overlay may not exist for this document — safe to ignore
  }

  // Git commit
  const dataRoot = getDataRoot();
  await gitExec(["add", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Knowledge Store",
      "-c", "user.email=system@knowledge-store.local",
      "commit",
      "-m", `delete document: ${docPath}`,
      "--allow-empty",
    ],
    dataRoot,
  );

  return jsonToolResult({ success: true, doc_path: docPath, deleted: true });
}

// Exported for use by structural tools
export { deleteDocument };

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
