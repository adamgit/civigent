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
 * proposals using the tombstone pattern: delete writes an empty skeleton,
 * rename writes tombstone at old path + full content at new path.
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult } from "../tool-registry.js";
import { makeToolErrorResult } from "../protocol.js";
import { getContentRoot } from "../../storage/data-root.js";
import { DocumentSkeleton } from "../../storage/document-skeleton.js";
import { DocumentNotFoundError } from "../../storage/document-reader.js";
import { InvalidDocPathError, resolveDocPathUnderContent } from "../../storage/path-utils.js";
import { lookupDocSession } from "../../crdt/ydoc-lifecycle.js";
import {
  readProposal,
  updateProposalSections,
  ProposalNotFoundError,
  InvalidProposalStateError,
} from "../../storage/proposal-repository.js";
import { evaluateProposalHumanInvolvement } from "../../storage/commit-pipeline.js";
import type { McpToolCallResult } from "../protocol.js";
import type { AnyProposal, ProposalSection } from "../../types/shared.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { SectionRef } from "../../domain/section-ref.js";
import { checkDocPermission } from "../../auth/acl.js";

// ─── Proposal validation helper ──────────────────────────

async function loadAndValidateProposal(
  proposalId: string,
  writerId: string,
): Promise<{ proposal: AnyProposal; contentRoot: string } | McpToolCallResult> {
  try {
    const proposal = await readProposal(proposalId);
    if (proposal.writer.id !== writerId) {
      return makeToolErrorResult("You can only modify your own proposals.");
    }
    if (proposal.status !== "draft") {
      return makeToolErrorResult(`Cannot modify proposal in ${proposal.status} state.`);
    }
    // Derive content root from proposal
    const { proposalContentRoot } = await import("../../storage/proposal-repository.js");
    const contentRoot = proposalContentRoot(proposalId, "draft");
    return { proposal, contentRoot };
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

// ─── Session contention guard ────────────────────────────

function checkDocSessionGuard(docPath: string): McpToolCallResult | null {
  const session = lookupDocSession(docPath);
  if (!session) return null;
  if (session.holders.size > 0) {
    return makeToolErrorResult(
      `Cannot modify document structure: active editing session exists on "${docPath}".`,
    );
  }
  for (const dirtySet of session.perUserDirty.values()) {
    if (dirtySet.size > 0) {
      return makeToolErrorResult(
        `Cannot modify document structure: uncommitted edits exist on "${docPath}". Wait for auto-commit to flush.`,
      );
    }
  }
  return null;
}

// ─── create_section (proposal-based) ─────────────────────

const createSectionHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const content = (args.content as string | undefined) ?? "";

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Missing required parameter: heading_path (non-empty array)");
  }

  // Validate doc_path before any state is created
  try {
    resolveDocPathUnderContent(getContentRoot(), docPath);
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Invalid doc_path "${docPath}": ${error.message}`);
    }
    throw error;
  }

  const writeOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!writeOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;
  const { proposal, contentRoot: proposalContentRoot } = validated;

  try {
    const canonicalRoot = getContentRoot();
    // Load skeleton from overlay (proposal content) with canonical fallback
    const skeleton = await DocumentSkeleton.fromDisk(docPath, proposalContentRoot, canonicalRoot);
    const heading = headingPath[headingPath.length - 1];
    const parentPath = headingPath.slice(0, -1);

    // Derive level from the skeleton's existing hierarchy
    let level: number;
    if (parentPath.length === 0) {
      // Top-level section — level 1 (or match existing siblings)
      level = 1;
    } else {
      const parentEntry = skeleton.resolve(parentPath);
      level = parentEntry.level + 1;
    }

    skeleton.insertSectionUnder(parentPath, { heading, level, body: content });

    // Write body content through ContentLayer BEFORE skeleton.persist()
    // so that if body write fails, the skeleton doesn't reference a missing file.
    const proposalLayer = new ContentLayer(proposalContentRoot);
    await proposalLayer.writeSection(new SectionRef(docPath, headingPath), content);

    await skeleton.persist();

    // Update proposal sections metadata
    const existingSections = proposal.sections.filter(
      (s) => !(s.doc_path === docPath && JSON.stringify(s.heading_path) === JSON.stringify(headingPath)),
    );
    const updatedSections: ProposalSection[] = [
      ...existingSections,
      { doc_path: docPath, heading_path: headingPath },
    ];
    const { proposal: updated } = await updateProposalSections(proposalId, updatedSections);

    // Broadcast proposal:draft
    if (ctx.emitEvent && updated.sections.length > 0) {
      ctx.emitEvent({
        type: "proposal:draft",
        proposal_id: updated.id,
        doc_path: updated.sections[0].doc_path,
        heading_paths: updated.sections.map((s) => s.heading_path),
        writer_id: ctx.writer.id,
        writer_display_name: ctx.writer.displayName,
        intent: updated.intent,
      });
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      heading_path: headingPath,
      created: true,
      evaluation,
      sections,
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
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Cannot delete the root section.");
  }

  // Validate doc_path before any state is created
  try {
    resolveDocPathUnderContent(getContentRoot(), docPath);
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Invalid doc_path "${docPath}": ${error.message}`);
    }
    throw error;
  }

  const delWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!delWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;
  const { proposal, contentRoot: proposalContentRoot } = validated;

  try {
    const canonicalRoot = getContentRoot();
    const skeleton = await DocumentSkeleton.fromDisk(docPath, proposalContentRoot, canonicalRoot);
    skeleton.replace(headingPath, []);
    await skeleton.persist();

    // Update proposal sections metadata
    const existingSections = proposal.sections.filter(
      (s) => !(s.doc_path === docPath && JSON.stringify(s.heading_path) === JSON.stringify(headingPath)),
    );
    const updatedSections: ProposalSection[] = [
      ...existingSections,
      { doc_path: docPath, heading_path: headingPath },
    ];
    const { proposal: updated } = await updateProposalSections(proposalId, updatedSections);

    if (ctx.emitEvent && updated.sections.length > 0) {
      ctx.emitEvent({
        type: "proposal:draft",
        proposal_id: updated.id,
        doc_path: updated.sections[0].doc_path,
        heading_paths: updated.sections.map((s) => s.heading_path),
        writer_id: ctx.writer.id,
        writer_display_name: ctx.writer.displayName,
        intent: updated.intent,
      });
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      heading_path: headingPath,
      deleted: true,
      evaluation,
      sections,
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
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const newParentPath = args.new_parent_path as string[] | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Cannot move the root section.");
  }
  if (!Array.isArray(newParentPath)) {
    return makeToolErrorResult("Missing required parameter: new_parent_path (string[])");
  }

  const moveWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!moveWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

  // Validate doc_path before any state is created
  try {
    resolveDocPathUnderContent(getContentRoot(), docPath);
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Invalid doc_path "${docPath}": ${error.message}`);
    }
    throw error;
  }

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;
  const { proposal, contentRoot: proposalContentRoot } = validated;

  try {
    const canonicalRoot = getContentRoot();
    const skeleton = await DocumentSkeleton.fromDisk(docPath, proposalContentRoot, canonicalRoot);

    // Read current body content via ContentLayer (overlay-first, then canonical)
    const clWithFallback = new ContentLayer(proposalContentRoot, new ContentLayer(canonicalRoot));
    let bodyContent = "";
    try {
      bodyContent = await clWithFallback.readSection(new SectionRef(docPath, headingPath));
    } catch {
      // Section body missing in both overlay and canonical — use empty
    }

    const heading = headingPath[headingPath.length - 1];
    const resolvedEntry = skeleton.resolve(headingPath);
    const targetLevel = newParentPath.length === 0
      ? resolvedEntry.level
      : newParentPath.length + 1;

    // Remove from old position
    skeleton.replace(headingPath, []);

    // Insert under the specified parent path
    skeleton.insertSectionUnder(newParentPath, {
      heading,
      level: targetLevel,
      body: bodyContent,
    });

    // Write body content through ContentLayer BEFORE skeleton.persist()
    // so that if body write fails, the skeleton doesn't reference a missing file.
    const moveLayer = new ContentLayer(proposalContentRoot);
    const newHeadingPathForMove = [...newParentPath, heading];
    await moveLayer.writeSection(new SectionRef(docPath, newHeadingPathForMove), bodyContent);

    await skeleton.persist();

    // Update proposal sections metadata
    const existingSections = proposal.sections.filter(
      (s) => !(s.doc_path === docPath && JSON.stringify(s.heading_path) === JSON.stringify(headingPath)),
    );
    const updatedSections: ProposalSection[] = [
      ...existingSections,
      { doc_path: docPath, heading_path: headingPath },
    ];
    const { proposal: updated } = await updateProposalSections(proposalId, updatedSections);

    if (ctx.emitEvent && updated.sections.length > 0) {
      ctx.emitEvent({
        type: "proposal:draft",
        proposal_id: updated.id,
        doc_path: updated.sections[0].doc_path,
        heading_paths: updated.sections.map((s) => s.heading_path),
        writer_id: ctx.writer.id,
        writer_display_name: ctx.writer.displayName,
        intent: updated.intent,
      });
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      heading_path: headingPath,
      new_parent_path: newParentPath,
      moved: true,
      evaluation,
      sections,
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
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const newHeading = args.new_heading as string | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath) || headingPath.length === 0) {
    return makeToolErrorResult("Cannot rename the root section.");
  }
  if (!newHeading) return makeToolErrorResult("Missing required parameter: new_heading");

  const renameWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!renameWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

  // Validate doc_path before any state is created
  try {
    resolveDocPathUnderContent(getContentRoot(), docPath);
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Invalid doc_path "${docPath}": ${error.message}`);
    }
    throw error;
  }

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;
  const { proposal, contentRoot: proposalContentRoot } = validated;

  try {
    const canonicalRoot = getContentRoot();
    const skeleton = await DocumentSkeleton.fromDisk(docPath, proposalContentRoot, canonicalRoot);

    // Read current body content via ContentLayer (overlay-first, then canonical)
    const clWithFallback = new ContentLayer(proposalContentRoot, new ContentLayer(canonicalRoot));
    let bodyContent = "";
    try {
      bodyContent = await clWithFallback.readSection(new SectionRef(docPath, headingPath));
    } catch {
      // Section body missing in both overlay and canonical — use empty
    }

    // Replace with new heading, same content
    const resolvedEntry = skeleton.resolve(headingPath);
    const result = skeleton.replace(headingPath, [
      { heading: newHeading, level: resolvedEntry.level, body: bodyContent },
    ]);

    // Write body content through ContentLayer BEFORE skeleton.persist()
    // so that if body write fails, the skeleton doesn't reference a missing file.
    const newHeadingPath = [...headingPath.slice(0, -1), newHeading];
    const renameLayer = new ContentLayer(proposalContentRoot);
    await renameLayer.writeSection(new SectionRef(docPath, newHeadingPath), bodyContent);

    await skeleton.persist();

    // Update proposal sections metadata with new heading path
    const existingSections = proposal.sections.filter(
      (s) => !(s.doc_path === docPath && JSON.stringify(s.heading_path) === JSON.stringify(headingPath)),
    );
    const updatedSections: ProposalSection[] = [
      ...existingSections,
      { doc_path: docPath, heading_path: newHeadingPath },
    ];
    const { proposal: updated } = await updateProposalSections(proposalId, updatedSections);

    if (ctx.emitEvent && updated.sections.length > 0) {
      ctx.emitEvent({
        type: "proposal:draft",
        proposal_id: updated.id,
        doc_path: updated.sections[0].doc_path,
        heading_paths: updated.sections.map((s) => s.heading_path),
        writer_id: ctx.writer.id,
        writer_display_name: ctx.writer.displayName,
        intent: updated.intent,
      });
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      old_heading_path: headingPath,
      new_heading_path: newHeadingPath,
      renamed: true,
      evaluation,
      sections,
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
  const docPath = args.path as string | undefined;
  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!docPath) return makeToolErrorResult("Missing required parameter: path");

  const delDocWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!delDocWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

  // Validate doc_path before any state is created
  try {
    resolveDocPathUnderContent(getContentRoot(), docPath);
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Invalid path "${docPath}": ${error.message}`);
    }
    throw error;
  }

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;
  const { proposal, contentRoot: proposalContentRoot } = validated;

  // Block if active CRDT session exists
  const sessionBlock = checkDocSessionGuard(docPath);
  if (sessionBlock) return sessionBlock;

  try {
    const canonicalRoot = getContentRoot();

    // Load canonical skeleton to get all sections for proposal metadata
    const skeleton = await DocumentSkeleton.fromDisk(docPath, canonicalRoot, canonicalRoot);
    const headingPaths: string[][] = [];
    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath) => {
      headingPaths.push([...headingPath]);
    });

    // Create tombstone skeleton in proposal overlay
    const tombstone = DocumentSkeleton.createTombstone(docPath, proposalContentRoot);
    await tombstone.persist();

    // Add all document sections to proposal's sections[] metadata
    const existingSections = proposal.sections.filter(
      (s) => s.doc_path !== docPath,
    );
    const updatedSections: ProposalSection[] = [
      ...existingSections,
      ...headingPaths.map((hp) => ({ doc_path: docPath, heading_path: hp })),
    ];
    const { proposal: updated } = await updateProposalSections(proposalId, updatedSections);

    if (ctx.emitEvent && updated.sections.length > 0) {
      ctx.emitEvent({
        type: "proposal:draft",
        proposal_id: updated.id,
        doc_path: docPath,
        heading_paths: updated.sections.map((s) => s.heading_path),
        writer_id: ctx.writer.id,
        writer_display_name: ctx.writer.displayName,
        intent: updated.intent,
      });
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      doc_path: docPath,
      deleted: true,
      evaluation,
      sections,
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
  const docPath = args.doc_path as string | undefined;
  const newPath = args.new_path as string | undefined;
  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!newPath) return makeToolErrorResult("Missing required parameter: new_path");

  // Check write permission on both source (delete) and destination (create)
  const srcWriteOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!srcWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);
  const dstWriteOk = await checkDocPermission(ctx.writer, newPath, "write");
  if (!dstWriteOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${newPath}".`);

  // Validate both old and new doc_path before any state is created
  const renameContentRoot = getContentRoot();
  for (const [label, p] of [["doc_path", docPath], ["new_path", newPath]] as const) {
    try {
      resolveDocPathUnderContent(renameContentRoot, p);
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        return makeToolErrorResult(`Invalid ${label} "${p}": ${error.message}`);
      }
      throw error;
    }
  }

  const validated = await loadAndValidateProposal(proposalId, ctx.writer.id);
  if (isError(validated)) return validated;
  const { proposal, contentRoot: proposalContentRoot } = validated;

  // Block if active CRDT session exists
  const sessionBlock = checkDocSessionGuard(docPath);
  if (sessionBlock) return sessionBlock;

  try {
    const canonicalRoot = getContentRoot();

    // Load canonical skeleton for the old doc
    const oldSkeleton = await DocumentSkeleton.fromDisk(docPath, canonicalRoot, canonicalRoot);
    const headingPaths: string[][] = [];
    oldSkeleton.forEachSection((_heading, _level, _sectionFile, headingPath) => {
      headingPaths.push([...headingPath]);
    });

    // Step 1: Write tombstone at old path in proposal overlay
    const tombstone = DocumentSkeleton.createTombstone(docPath, proposalContentRoot);
    await tombstone.persist();

    // Step 2: Copy full content to new path in proposal overlay using skeleton API.
    const subtree = await new ContentLayer(canonicalRoot).readSubtree(docPath, []);

    // Create a new empty skeleton at the new doc path in the proposal overlay
    const newSkeleton = DocumentSkeleton.createEmpty(newPath, proposalContentRoot);

    // Insert all non-root sections under their correct parent paths
    for (const entry of subtree) {
      if (entry.headingPath.length === 0) continue; // root handled below
      const parentPath = entry.headingPath.slice(0, -1);
      newSkeleton.insertSectionUnder(parentPath, {
        heading: entry.heading,
        level: entry.level,
        body: entry.bodyContent,
      });
    }
    await newSkeleton.persist();

    // Write body files into the new skeleton's overlay locations
    const newContentLayer = new ContentLayer(proposalContentRoot);
    for (const entry of subtree) {
      await newContentLayer.writeSection(
        new SectionRef(newPath, entry.headingPath),
        entry.bodyContent,
      );
    }

    // Step 3: Update proposal sections metadata — add entries for new-path sections
    // Include both old-path sections (being deleted by tombstone) and new-path
    // sections so evaluateProposalHumanInvolvement checks contention on both.
    const existingSections = proposal.sections.filter(
      (s) => s.doc_path !== docPath && s.doc_path !== newPath,
    );
    const updatedSections: ProposalSection[] = [
      ...existingSections,
      ...headingPaths.map((hp) => ({ doc_path: docPath, heading_path: hp })),
      ...headingPaths.map((hp) => ({ doc_path: newPath, heading_path: hp })),
    ];
    const { proposal: updated } = await updateProposalSections(proposalId, updatedSections);

    if (ctx.emitEvent && updated.sections.length > 0) {
      ctx.emitEvent({
        type: "proposal:draft",
        proposal_id: updated.id,
        doc_path: newPath,
        heading_paths: updated.sections.map((s) => s.heading_path),
        writer_id: ctx.writer.id,
        writer_display_name: ctx.writer.displayName,
        intent: updated.intent,
      });
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      old_path: docPath,
      new_path: newPath,
      renamed: true,
      evaluation,
      sections,
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
    {
      name: "create_section",
      description: "Create a new section within a document. Operates within a proposal.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "Active proposal ID (required)" },
          doc_path: { type: "string", description: "Document path (must end with .md)" },
          heading_path: { type: "array", items: { type: "string" }, description: "Heading path for the new section" },
          content: { type: "string", description: "Initial content (markdown)" },
        },
        required: ["proposal_id", "doc_path", "heading_path"],
      },
    },
    createSectionHandler,
  );

  registry.register(
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
