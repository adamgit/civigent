/**
 * Tier 3 MCP tools — collaboration surface with explicit proposals.
 *
 * Tools: list_docs, read_doc, read_doc_structure, read_section,
 *        create_proposal, commit_proposal, cancel_proposal,
 *        list_proposals, read_proposal, write_section
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult, textToolResult } from "../tool-registry.js";
import { makeToolErrorResult } from "../protocol.js";
import { readAssembledDocument, DocumentNotFoundError } from "../../storage/document-reader.js";
import { readDocumentsTree } from "../../storage/documents-tree.js";
import { readSectionWithHeading, SectionNotFoundError } from "../../storage/section-reader.js";
import { getContentRoot, getDataRoot, getSessionDocsRoot } from "../../storage/data-root.js";
import { ContentLayer } from "../../storage/content-layer.js";
import { getHeadSha } from "../../storage/git-repo.js";
import {
  readDocumentStructure,
  readDocumentStructureWithOverlay,
  flattenStructureToHeadingPaths,
  resolveAllSectionPaths,
  HeadingNotFoundError,
} from "../../storage/heading-resolver.js";
import {
  createProposal,
  readProposal,
  readProposalWithContent,
  listProposals,
  findPendingProposalByWriter,
  updateProposalSections,
  transitionToWithdrawn,
  ProposalNotFoundError,
  InvalidProposalStateError,
} from "../../storage/proposal-repository.js";
import {
  evaluateProposalHumanInvolvement,
  commitProposalToCanonical,
} from "../../storage/commit-pipeline.js";
import { SectionRef } from "../../domain/section-ref.js";
import { InvalidDocPathError } from "../../storage/path-utils.js";
import type { SectionScoreSnapshot } from "../../types/shared.js";
import path from "node:path";

// ─── list_docs ───────────────────────────────────────────

const listDocsHandler: ToolHandler = async (args) => {
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

// ─── read_doc ────────────────────────────────────────────

const readDocHandler: ToolHandler = async (args, ctx) => {
  const docPath = args.path as string | undefined;
  if (!docPath) return makeToolErrorResult("Missing required parameter: path");

  try {
    const content = await readAssembledDocument(docPath);
    const headSha = await getHeadSha(getDataRoot());
    const structure = await readDocumentStructure(docPath).catch(() => []);
    const headingPaths = flattenStructureToHeadingPaths(structure);

    // Broadcast agent:reading
    if (ctx.writer.type === "agent" && ctx.emitEvent) {
      ctx.emitEvent({
        type: "agent:reading",
        actor_id: ctx.writer.id,
        actor_display_name: ctx.writer.displayName,
        doc_path: docPath,
        heading_paths: headingPaths,
      });
    }

    return jsonToolResult({
      doc_path: docPath,
      content,
      head_sha: headSha,
      headings: headingPaths.map((hp) => hp.join(" > ")),
    });
  } catch (error) {
    if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Document not found: ${docPath}`);
    }
    throw error;
  }
};

// ─── read_doc_structure ──────────────────────────────────

const readDocStructureHandler: ToolHandler = async (args, ctx) => {
  const docPath = args.path as string | undefined;
  if (!docPath) return makeToolErrorResult("Missing required parameter: path");

  try {
    const sessionDocsContentRoot = path.join(getSessionDocsRoot(), "content");
    const structure = await readDocumentStructureWithOverlay(docPath, sessionDocsContentRoot);

    // Broadcast agent:reading
    if (ctx.writer.type === "agent" && ctx.emitEvent) {
      const headingPaths = flattenStructureToHeadingPaths(structure);
      ctx.emitEvent({
        type: "agent:reading",
        actor_id: ctx.writer.id,
        actor_display_name: ctx.writer.displayName,
        doc_path: docPath,
        heading_paths: headingPaths,
      });
    }

    return jsonToolResult({ doc_path: docPath, structure });
  } catch (error) {
    if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Document not found: ${docPath}`);
    }
    throw error;
  }
};

// ─── read_section ────────────────────────────────────────

const readSectionHandler: ToolHandler = async (args, ctx) => {
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;

  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath)) return makeToolErrorResult("Missing required parameter: heading_path (array of strings)");

  try {
    const content = await readSectionWithHeading(docPath, headingPath);
    const headSha = await getHeadSha(getDataRoot());

    // Broadcast agent:reading
    if (ctx.writer.type === "agent" && ctx.emitEvent) {
      ctx.emitEvent({
        type: "agent:reading",
        actor_id: ctx.writer.id,
        actor_display_name: ctx.writer.displayName,
        doc_path: docPath,
        heading_paths: [headingPath],
      });
    }

    return jsonToolResult({
      doc_path: docPath,
      heading_path: headingPath,
      content,
      head_sha: headSha,
    });
  } catch (error) {
    if (error instanceof SectionNotFoundError || error instanceof HeadingNotFoundError) {
      return makeToolErrorResult(`Section not found: ${headingPath.join(" > ")} in ${docPath}`);
    }
    if (error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Invalid document path: ${docPath}`);
    }
    throw error;
  }
};

// ─── create_proposal ─────────────────────────────────────

const createProposalHandler: ToolHandler = async (args, ctx) => {
  const intent = args.intent as string | undefined;
  const sections = args.sections as Array<{
    doc_path: string;
    heading_path: string[];
    content: string;
    justification?: string;
  }> | undefined;

  if (!intent) return makeToolErrorResult("Missing required parameter: intent");
  if (!Array.isArray(sections) || sections.length === 0) {
    return makeToolErrorResult("Missing required parameter: sections (non-empty array)");
  }

  for (const s of sections) {
    if (!s.doc_path || !Array.isArray(s.heading_path) || typeof s.content !== "string") {
      return makeToolErrorResult("Each section must have doc_path (string), heading_path (string[]), and content (string)");
    }
  }

  const writer = ctx.writer;

  // Check for existing pending proposal
  const existing = await findPendingProposalByWriter(writer.id);
  if (existing) {
    const replaceFlag = args.replace as boolean | undefined;
    if (replaceFlag) {
      await transitionToWithdrawn(existing.id, "auto-withdrawn by replace flag");
    } else {
      return jsonToolResult({
        success: false,
        error: "You already have a pending proposal.",
        existing_proposal_id: existing.id,
        hint: "Set replace=true to auto-withdraw the existing proposal, or cancel it first.",
      });
    }
  }

  const { proposal, contentRoot } = await createProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
    sections.map((s) => ({
      doc_path: s.doc_path,
      heading_path: s.heading_path,
      justification: s.justification,
    })),
  );

  // Write section content to proposal's content directory
  const pContentLayer = new ContentLayer(contentRoot);
  for (const s of sections) {
    await pContentLayer.writeSection(SectionRef.fromTarget(s), s.content);
  }

  // Evaluate immediately (informational — agent must call commit_proposal explicitly)
  const { evaluation, sections: evaluatedSections } = await evaluateProposalHumanInvolvement(proposal);

  // Broadcast proposal:created so frontends show the pending indicator
  if (ctx.emitEvent && evaluatedSections.length > 0) {
    ctx.emitEvent({
      type: "proposal:pending",
      proposal_id: proposal.id,
      doc_path: evaluatedSections[0].doc_path,
      heading_paths: evaluatedSections.map((s) => s.heading_path),
      writer_id: writer.id,
      writer_display_name: writer.displayName,
      intent,
    });
  }

  return jsonToolResult({
    proposal_id: proposal.id,
    status: "pending",
    outcome: evaluation.all_sections_accepted ? "accepted" : "blocked",
    evaluation,
    sections: evaluatedSections,
  });
};

// ─── commit_proposal ─────────────────────────────────────

const commitProposalHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");

  try {
    const proposal = await readProposal(proposalId);

    if (proposal.writer.id !== ctx.writer.id) {
      return makeToolErrorResult("You can only commit your own proposals.");
    }
    if (proposal.status !== "pending") {
      return makeToolErrorResult(`Cannot commit proposal in ${proposal.status} state.`);
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposal);

    if (evaluation.all_sections_accepted) {
      const scores: SectionScoreSnapshot = {};
      for (const s of sections) {
        scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
      }

      const committedHead = await commitProposalToCanonical(proposal, scores);

      if (ctx.emitEvent) {
        ctx.emitEvent({
          type: "content:committed",
          doc_path: sections[0]?.doc_path ?? "",
          sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
          commit_sha: committedHead,
          source: "agent_proposal",
          writer_id: ctx.writer.id,
          writer_display_name: ctx.writer.displayName,
        });
      }

      return jsonToolResult({
        proposal_id: proposalId,
        status: "committed",
        outcome: "accepted",
        committed_head: committedHead,
        evaluation,
        sections,
      });
    } else {
      return jsonToolResult({
        proposal_id: proposalId,
        status: "pending",
        outcome: "blocked",
        evaluation,
        sections,
      });
    }
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return makeToolErrorResult(`Proposal not found: ${proposalId}`);
    }
    if (error instanceof InvalidProposalStateError) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── cancel_proposal ─────────────────────────────────────

const cancelProposalHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const reason = args.reason as string | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");

  try {
    const proposal = await readProposal(proposalId);
    if (proposal.writer.id !== ctx.writer.id) {
      return makeToolErrorResult("You can only cancel your own proposals.");
    }

    await transitionToWithdrawn(proposalId, reason);

    return jsonToolResult({
      proposal_id: proposalId,
      status: "withdrawn",
    });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return makeToolErrorResult(`Proposal not found: ${proposalId}`);
    }
    if (error instanceof InvalidProposalStateError) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── list_proposals ──────────────────────────────────────

const listProposalsHandler: ToolHandler = async (args) => {
  const status = args.status as string | undefined;
  const validStatuses = ["pending", "committed", "withdrawn"];

  if (status && !validStatuses.includes(status)) {
    return makeToolErrorResult(`Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
  }

  const proposals = await listProposals(status as any);
  return jsonToolResult({ proposals });
};

// ─── my_proposals ───────────────────────────────────────

const myProposalsHandler: ToolHandler = async (args, ctx) => {
  const status = args.status as string | undefined;
  const validStatuses = ["pending", "committed", "withdrawn"];

  if (status && !validStatuses.includes(status)) {
    return makeToolErrorResult(`Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
  }

  const all = await listProposals(status as any);
  const mine = all.filter(p => p.writer.id === ctx.writer.id);
  return jsonToolResult({ proposals: mine });
};

// ─── read_proposal ───────────────────────────────────────

const readProposalHandler: ToolHandler = async (args) => {
  const proposalId = args.proposal_id as string | undefined;
  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");

  try {
    const { proposal, sectionContent } = await readProposalWithContent(proposalId);

    // Re-evaluate human-involvement for pending proposals
    let evaluation = proposal.humanInvolvement_evaluation;
    if (proposal.status === "pending") {
      const result = await evaluateProposalHumanInvolvement(proposal);
      evaluation = result.evaluation;
    }

    // Return content as a separate map, not on section objects
    const contentMap: Record<string, string> = {};
    for (const [key, value] of sectionContent) {
      contentMap[key] = value;
    }

    return jsonToolResult({
      proposal: { ...proposal, humanInvolvement_evaluation: evaluation },
      section_content: contentMap,
    });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return makeToolErrorResult(`Proposal not found: ${proposalId}`);
    }
    throw error;
  }
};

// ─── write_section ───────────────────────────────────────

const writeSectionHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const content = args.content as string | undefined;
  const justification = args.justification as string | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath)) return makeToolErrorResult("Missing required parameter: heading_path");
  if (content === undefined) return makeToolErrorResult("Missing required parameter: content");

  try {
    const proposal = await readProposal(proposalId);
    if (proposal.writer.id !== ctx.writer.id) {
      return makeToolErrorResult("You can only modify your own proposals.");
    }
    if (proposal.status !== "pending") {
      return makeToolErrorResult(`Cannot modify proposal in ${proposal.status} state.`);
    }

    // Update the proposal with the new/modified section
    const existingSections = proposal.sections.filter(
      (s) => !(s.doc_path === docPath && JSON.stringify(s.heading_path) === JSON.stringify(headingPath)),
    );

    const updatedSections = [
      ...existingSections,
      { doc_path: docPath, heading_path: headingPath, justification },
    ];

    const { proposal: updated, contentRoot: updContentRoot } = await updateProposalSections(
      proposalId,
      updatedSections,
    );

    // Write section content to proposal's content directory
    const wContentLayer = new ContentLayer(updContentRoot);
    await wContentLayer.writeSection(new SectionRef(docPath, headingPath), content);

    // Broadcast proposal:pending with updated sections
    if (ctx.emitEvent && updated.sections.length > 0) {
      ctx.emitEvent({
        type: "proposal:pending",
        proposal_id: updated.id,
        doc_path: updated.sections[0].doc_path,
        heading_paths: updated.sections.map((s) => s.heading_path),
        writer_id: ctx.writer.id,
        writer_display_name: ctx.writer.displayName,
        intent: updated.intent,
      });
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(updated);

    return jsonToolResult({
      proposal_id: proposalId,
      status: "pending",
      evaluation,
      sections,
    });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return makeToolErrorResult(`Proposal not found: ${proposalId}`);
    }
    if (error instanceof InvalidProposalStateError) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── Registration ────────────────────────────────────────

export function registerCollaborationTools(registry: ToolRegistry): void {
  registry.register(
    {
      name: "list_docs",
      description: "List documents and directories in the Knowledge Store.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to list (empty for root)" },
        },
      },
    },
    listDocsHandler,
  );

  registry.register(
    {
      name: "read_doc",
      description: "Read the full assembled markdown content of a document, including its heading structure.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Document path" },
        },
        required: ["path"],
      },
    },
    readDocHandler,
  );

  registry.register(
    {
      name: "read_doc_structure",
      description: "Read the heading structure of a document without fetching body content. Useful for understanding document organization before reading specific sections.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Document path" },
        },
        required: ["path"],
      },
    },
    readDocStructureHandler,
  );

  registry.register(
    {
      name: "read_section",
      description: "Read the content of a specific section within a document. More efficient than reading the full document when you only need one section.",
      inputSchema: {
        type: "object",
        properties: {
          doc_path: { type: "string", description: "Document path" },
          heading_path: {
            type: "array",
            items: { type: "string" },
            description: "Heading path as array of heading names, e.g. ['Getting Started', 'Installation']",
          },
        },
        required: ["doc_path", "heading_path"],
      },
    },
    readSectionHandler,
  );

  registry.register(
    {
      name: "create_proposal",
      description: "Create a new proposal with intent and section changes. The proposal starts in pending status. Use commit_proposal to commit it.",
      inputSchema: {
        type: "object",
        properties: {
          intent: { type: "string", description: "Human-readable description of what you're changing and why" },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                doc_path: { type: "string" },
                heading_path: { type: "array", items: { type: "string" } },
                content: { type: "string" },
                justification: { type: "string", description: "Optional justification for overwriting this section" },
              },
              required: ["doc_path", "heading_path", "content"],
            },
            description: "Sections to create or overwrite",
          },
          replace: { type: "boolean", description: "Auto-withdraw existing pending proposal if one exists" },
        },
        required: ["intent", "sections"],
      },
    },
    createProposalHandler,
  );

  registry.register(
    {
      name: "write_section",
      description: "Write content to a specific section within an existing pending proposal. Adds or updates a section in the proposal.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "ID of the pending proposal" },
          doc_path: { type: "string", description: "Document path" },
          heading_path: { type: "array", items: { type: "string" }, description: "Section heading path" },
          content: { type: "string", description: "New section content (markdown)" },
          justification: { type: "string", description: "Optional justification for overwriting this section" },
        },
        required: ["proposal_id", "doc_path", "heading_path", "content"],
      },
    },
    writeSectionHandler,
  );

  registry.register(
    {
      name: "commit_proposal",
      description: "Attempt to commit a pending proposal. Re-evaluates human-involvement for all sections. If all pass, the proposal is committed to canonical. If any are blocked, the proposal remains pending.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "ID of the proposal to commit" },
        },
        required: ["proposal_id"],
      },
    },
    commitProposalHandler,
  );

  registry.register(
    {
      name: "cancel_proposal",
      description: "Withdraw/cancel a pending proposal. The proposal moves to withdrawn state and cannot be modified further.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "ID of the proposal to cancel" },
          reason: { type: "string", description: "Optional reason for cancellation" },
        },
        required: ["proposal_id"],
      },
    },
    cancelProposalHandler,
  );

  registry.register(
    {
      name: "list_proposals",
      description: "List proposals, optionally filtered by status.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status: pending, committed, or withdrawn" },
        },
      },
    },
    listProposalsHandler,
  );

  registry.register(
    {
      name: "my_proposals",
      description: "List your own proposals, optionally filtered by status. Preferred way to check your proposal state.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status: pending, committed, or withdrawn" },
        },
      },
    },
    myProposalsHandler,
  );

  registry.register(
    {
      name: "read_proposal",
      description: "Read the details of a specific proposal, including its sections and human-involvement evaluation.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "Proposal ID" },
        },
        required: ["proposal_id"],
      },
    },
    readProposalHandler,
  );
}
