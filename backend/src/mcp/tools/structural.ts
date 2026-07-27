/**
 * Tier 3 structural MCP tools — section creation, deletion, movement, renaming.
 *
 * Tools: create_section, delete_section, move_section, rename_section,
 *        delete_document, rename_document
 *
 * All section-level structural tools operate within a proposal: they require
 * a proposal_id, verify ownership and pending status, and write skeleton +
 * section file changes to the proposal's content overlay (NOT to canonical).
 * Commit happens via commit_proposal, which promotes overlay → canonical.
 *
 * Document-level tools (delete_document, rename_document) also operate within
 * proposals using the tombstone pattern: delete writes a tombstone marker,
 * rename writes tombstone at old path + full content at new path.
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult } from "../tool-registry.js";
import { makeToolErrorResult, parseToolArgumentDocPath } from "../protocol.js";
import { DocumentNotFoundError } from "../../storage/document-reader.js";
import { InvalidDocPathError } from "../../storage/path-utils.js";
import {
  readProposal,
  isProposalMutable,
  ProposalNotFoundError,
  InvalidProposalStateError,
} from "../../storage/proposal-repository.js";
import { mutateProposalContent, ProposalSectionNotFoundError } from "../../storage/mutate-proposal-content.js";
import { sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
import { evaluateAgentWritePolicy } from "../../storage/commit-pipeline.js";
import { agentWritePolicyToolBody } from "./agent-write-policy-body.js";
import type { McpToolCallResult } from "../protocol.js";
import type { AnyProposal } from "../../types/shared.js";
import { checkDocPermission } from "../../auth/acl.js";
import { emitProposalDraftEventsByDoc } from "../../api/application/events.js";

// ─── Proposal validation helper ──────────────────────────

async function loadAndValidateProposal(
  proposalId: string,
  writerId: string,
): Promise<{ proposal: AnyProposal } | McpToolCallResult> {
  try {
    const proposal = await readProposal(proposalId);
    if (proposal.writer.id !== writerId) {
      return makeToolErrorResult("You can only modify your own proposals.");
    }
    if (!isProposalMutable(proposal)) {
      return makeToolErrorResult(`Cannot modify proposal in ${proposal.status} state.`);
    }
    // Validation only — the manifest-owning mutation goes through
    // `mutateProposalContent(...)`, which opens its own short-lived editor.
    return { proposal };
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return makeToolErrorResult(`Proposal not found: ${proposalId}`);
    }
    if (error instanceof InvalidProposalStateError) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
}

function isError(result: unknown): result is McpToolCallResult {
  return result !== null && typeof result === "object" && "content" in (result as Record<string, unknown>);
}

// NOTE: MCP structural tools stage proposal DRAFT content only — they never
// mutate an active Y.Doc or canonical topology. The former per-tool DocSession
// contention guard (lookupDocSession/countEditorSockets/per-user dirty tracking)
// has been removed: structural tools may stage draft changes while a DocSession exists,
// and topology safety is enforced at the publish/commit boundary by the
// DocSession actor's publish-or-abort / invalidation policy (Areas B/C/F).

// ─── create_section (proposal-based) ─────────────────────

const createSectionHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const rawDocPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const content = (args.content as string | undefined) ?? "";

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Missing required parameter: heading_path (non-empty array)");
  }

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  const writeOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!writeOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;

  try {
    // Auto-create headings + write content AND derive the manifest from the real
    // parser-expanded sections (embedded headings become real sections) — never
    // from the requested heading path alone (Claim 3).
    const heading = headingPath.length === 0 ? "" : headingPath[headingPath.length - 1]!;
    const { proposal: updated } = await mutateProposalContent(proposalId, {
      kind: "create_section",
      docPath,
      headingPath,
      heading,
      content: content === undefined ? undefined : sectionWriteInputFromExternal(content),
    });

    // Broadcast proposal:draft
    emitProposalDraftEventsByDoc(ctx.emitEvent, updated.id, ctx.writer, updated.intent, updated.targets);

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      heading_path: headingPath,
      created: true,
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── delete_section (proposal-based) ─────────────────────

const deleteSectionHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const rawDocPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Cannot delete the before-first-heading section. Use document delete to remove the entire document.");
  }

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  const delWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!delWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;

  try {
    // The manifest is derived from the REAL removed subtree (target + every
    // deleted descendant) by the mutation boundary (Claim 3).
    const { proposal: updated } = await mutateProposalContent(proposalId, {
      kind: "delete_section",
      docPath,
      headingPath,
    });

    emitProposalDraftEventsByDoc(ctx.emitEvent, updated.id, ctx.writer, updated.intent, updated.targets);

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      heading_path: headingPath,
      deleted: true,
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── move_section (proposal-based) ───────────────────────

const moveSectionHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const rawDocPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const newParentPath = args.new_parent_path as string[] | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Cannot move the before-first-heading section.");
  }
  if (!Array.isArray(newParentPath)) {
    return makeToolErrorResult("Missing required parameter: new_parent_path (string[])");
  }

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  const moveWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!moveWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);


  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;

  try {
    // The boundary resolves the target level and derives the manifest from the
    // real removed (old) + added (new) identities of the moved subtree (Claim 3).
    let updated: AnyProposal;
    try {
      ({ proposal: updated } = await mutateProposalContent(proposalId, {
        kind: "move_section",
        docPath,
        headingPath,
        newParentPath,
      }));
    } catch (moveError) {
      if (moveError instanceof ProposalSectionNotFoundError) {
        return makeToolErrorResult(moveError.message);
      }
      throw moveError;
    }

    emitProposalDraftEventsByDoc(ctx.emitEvent, updated.id, ctx.writer, updated.intent, updated.targets);

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      heading_path: headingPath,
      new_parent_path: newParentPath,
      moved: true,
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── rename_section (proposal-based) ─────────────────────

const renameSectionHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const rawDocPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const newHeading = args.new_heading as string | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Cannot rename the before-first-heading section (it has no heading).");
  }
  if (!newHeading) return makeToolErrorResult("Missing required parameter: new_heading");

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  const renameWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!renameWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);


  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;

  try {
    // The boundary derives the manifest from the OLD removed identities and the
    // NEW added identities (descendants included), not just the new path (Claim 3).
    const { proposal: updated, newHeadingPath: mutatedHeadingPath } = await mutateProposalContent(proposalId, {
      kind: "rename_section",
      docPath,
      headingPath,
      newHeading,
    });
    const newHeadingPath = mutatedHeadingPath ?? [...headingPath.slice(0, -1), newHeading];

    emitProposalDraftEventsByDoc(ctx.emitEvent, updated.id, ctx.writer, updated.intent, updated.targets);

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      old_heading_path: headingPath,
      new_heading_path: newHeadingPath,
      renamed: true,
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── delete_document (proposal-based, tombstone pattern) ──

const deleteDocumentHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const rawDocPath = args.path as string | undefined;
  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: path");

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  const delDocWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!delDocWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;

  try {
    // The boundary tombstones the document and derives the manifest from the real
    // canonical heading paths going away (Claim 3).
    const { proposal: updated } = await mutateProposalContent(proposalId, {
      kind: "delete_document",
      docPath,
    });

    emitProposalDraftEventsByDoc(ctx.emitEvent, updated.id, ctx.writer, updated.intent, updated.targets);

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      deleted: true,
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  } catch (error) {
    if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Document not found: ${docPath}`);
    }
    throw error;
  }
};

// ─── rename_document (proposal-based, tombstone + copy) ───

const renameDocumentHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const rawDocPath = args.doc_path as string | undefined;
  const rawNewPath = args.new_path as string | undefined;
  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!rawNewPath) return makeToolErrorResult("Missing required parameter: new_path");

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const parsedNewPath = parseToolArgumentDocPath(rawNewPath);
  if ("errorResult" in parsedNewPath) return parsedNewPath.errorResult;
  const docPath = parsedDocPath.docPath;
  const newPath = parsedNewPath.docPath;

  // Check write permission on both source (delete) and destination (create)
  const srcWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!srcWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);
  const dstWriteOk = await checkDocPermission(ctx.writer, newPath, "write");
  if (!dstWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${newPath}".`);

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;

  try {
    // The boundary snapshots the source heading paths, performs the dedicated
    // document copy+tombstone rename, and derives the manifest from both the
    // old-path (tombstoned) and new-path (created) sections (Claim 3).
    const { proposal: updated } = await mutateProposalContent(proposalId, {
      kind: "rename_document",
      docPath,
      newPath,
    });

    emitProposalDraftEventsByDoc(ctx.emitEvent, updated.id, ctx.writer, updated.intent, updated.targets);

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      old_path: docPath,
      new_path: newPath,
      renamed: true,
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  } catch (error) {
    if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Document not found: ${docPath}`);
    }
    throw error;
  }
};

// ─── Registration ────────────────────────────────────────

export function registerStructuralTools(registry: ToolRegistry): void {
  registry.register(
    "createSection",
    {
      name: "create_section",
      description: "Create a section at the specified heading path within a document. Operates within a proposal. Missing ancestor headings are auto-created.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "Active proposal ID (required)" },
          doc_path: { type: "string", description: "Document path (must end with .md)" },
          heading_path: { type: "array", items: { type: "string" }, description: "Heading path for the new section" },
          content: { type: "string", description: "Initial content (markdown). Describes the section as the user wants it to read after the call." },
        },
        required: ["proposal_id", "doc_path", "heading_path"],
      },
    },
    createSectionHandler,
  );

  registry.register(
    "deleteSection",
    {
      name: "delete_section",
      description: "Delete a section from a document. Operates within a proposal.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "Active proposal ID (required)" },
          doc_path: { type: "string", description: "Document path (must end with .md)" },
          heading_path: { type: "array", items: { type: "string" }, description: "Section heading path to delete" },
        },
        required: ["proposal_id", "doc_path", "heading_path"],
      },
    },
    deleteSectionHandler,
  );

  registry.register(
    "moveSection",
    {
      name: "move_section",
      description: "Move a section to a new position in the document hierarchy. Operates within a proposal.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "Active proposal ID (required)" },
          doc_path: { type: "string", description: "Document path (must end with .md)" },
          heading_path: { type: "array", items: { type: "string" }, description: "Current heading path" },
          new_parent_path: { type: "array", items: { type: "string" }, description: "New parent heading path" },
        },
        required: ["proposal_id", "doc_path", "heading_path", "new_parent_path"],
      },
    },
    moveSectionHandler,
  );

  registry.register(
    "renameSection",
    {
      name: "rename_section",
      description: "Rename a section heading. Operates within a proposal.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "Active proposal ID (required)" },
          doc_path: { type: "string", description: "Document path (must end with .md)" },
          heading_path: { type: "array", items: { type: "string" }, description: "Current heading path" },
          new_heading: { type: "string", description: "New heading text" },
        },
        required: ["proposal_id", "doc_path", "heading_path", "new_heading"],
      },
    },
    renameSectionHandler,
  );

  registry.register(
    "deleteDocument",
    {
      name: "delete_document",
      description: "Delete an entire document from the Knowledge Store. Operates within a proposal.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "Active proposal ID (required)" },
          path: { type: "string", description: "Document path to delete (must end with .md)" },
        },
        required: ["proposal_id", "path"],
      },
    },
    deleteDocumentHandler,
  );

  registry.register(
    "renameDocument",
    {
      name: "rename_document",
      description: "Rename a document (move to a new path). Operates within a proposal.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "Active proposal ID (required)" },
          doc_path: { type: "string", description: "Current document path (must end with .md)" },
          new_path: { type: "string", description: "New document path (must end with .md)" },
        },
        required: ["proposal_id", "doc_path", "new_path"],
      },
    },
    renameDocumentHandler,
  );
}
