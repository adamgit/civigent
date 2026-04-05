/**
 * Tier 3 MCP tools — collaboration surface with explicit proposals.
 *
 * Tools: list_documents, list_sections, search_text,
 *        read_doc, read_doc_structure, read_section,
 *        create_proposal, commit_proposal, cancel_proposal,
 *        list_proposals, read_proposal, write_section
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult } from "../tool-registry.js";
import { makeToolErrorResult } from "../protocol.js";
import { readAssembledDocument, DocumentNotFoundError } from "../../storage/document-reader.js";
import { readSectionWithHeading, SectionNotFoundError } from "../../storage/section-reader.js";
import { getContentRoot, getDataRoot } from "../../storage/data-root.js";
import { OverlayContentLayer } from "../../storage/content-layer.js";
import { getHeadSha } from "../../storage/git-repo.js";
import {
  readDocumentStructure,
  flattenStructureToHeadingPaths,
  HeadingNotFoundError,
} from "../../storage/heading-resolver.js";
import {
  createProposal,
  readProposal,
  readProposalWithContent,
  listProposals,
  findDraftProposalByWriter,
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
import { INVOLVEMENT_THRESHOLD } from "../../domain/humanInvolvement.js";
import { InvalidDocPathError, resolveDocPathUnderContent } from "../../storage/path-utils.js";
import type { SectionScoreSnapshot, ProposalStatus, ProposalSection } from "../../types/shared.js";
import { checkDocPermission } from "../../auth/acl.js";
import { emitCatalogMutationEvents, summarizeProposalCatalogMutations } from "../catalog-events.js";
import {
  listReadableDocuments,
  listReadableSections,
  searchReadableText,
  DiscoveryValidationError,
  DiscoveryNotFoundError,
  SearchTextPatternError,
  SearchTextExecutionError,
} from "../../storage/discovery.js";

/**
 * Derive a human-readable block_reason from an evaluation result for MCP responses.
 * Helps agents understand which threshold caused the block.
 */
function deriveBlockReason(evaluation: {
  all_sections_accepted: boolean;
  aggregate_impact: number;
  aggregate_threshold: number;
  blocked_sections: Array<{ humanInvolvement_score: number }>;
}): string | undefined {
  if (evaluation.all_sections_accepted) return undefined;
  const hasPerSectionBlock = evaluation.blocked_sections.some(
    (s) => s.humanInvolvement_score >= INVOLVEMENT_THRESHOLD,
  );
  if (hasPerSectionBlock && evaluation.aggregate_impact > evaluation.aggregate_threshold) {
    return "per_section_threshold_and_aggregate_threshold";
  }
  if (hasPerSectionBlock) return "per_section_threshold";
  if (evaluation.aggregate_impact > evaluation.aggregate_threshold) return "aggregate_threshold";
  return "blocked";
}

// ─── discovery/search ────────────────────────────────────

const listDocumentsHandler: ToolHandler = async (args, ctx) => {
  const root = args.root as string | undefined;
  try {
    const documents = await listReadableDocuments(ctx.writer, root);
    return jsonToolResult({ documents });
  } catch (error) {
    if (error instanceof DiscoveryValidationError) {
      return makeToolErrorResult(error.message);
    }
    if (error instanceof DiscoveryNotFoundError) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

const listSectionsHandler: ToolHandler = async (args, ctx) => {
  const pathScope = args.path as string | undefined;
  try {
    const sections = await listReadableSections(ctx.writer, pathScope);
    return jsonToolResult({ sections });
  } catch (error) {
    if (error instanceof DiscoveryValidationError) {
      return makeToolErrorResult(error.message);
    }
    if (error instanceof DiscoveryNotFoundError) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

const searchTextHandler: ToolHandler = async (args, ctx) => {
  const pattern = args.pattern;
  const syntax = args.syntax;

  if (typeof pattern !== "string" || pattern.length === 0) {
    return makeToolErrorResult("Missing required parameter: pattern");
  }
  if (syntax !== "literal" && syntax !== "regexp") {
    return makeToolErrorResult('Missing required parameter: syntax ("literal" or "regexp")');
  }

  try {
    const matches = await searchReadableText(ctx.writer, {
      pattern,
      syntax,
      root: args.root as string | undefined,
      case_sensitive: args.case_sensitive as boolean | undefined,
      max_results: args.max_results as number | undefined,
      context_bytes: args.context_bytes as number | undefined,
    });
    return jsonToolResult({ matches });
  } catch (error) {
    if (error instanceof DiscoveryValidationError) {
      return makeToolErrorResult(error.message);
    }
    if (error instanceof DiscoveryNotFoundError) {
      return makeToolErrorResult(error.message);
    }
    if (error instanceof SearchTextPatternError) {
      return makeToolErrorResult(error.message);
    }
    if (error instanceof SearchTextExecutionError) {
      return makeToolErrorResult(error.message);
    }
    throw error;
  }
};

// ─── read_doc ────────────────────────────────────────────

const readDocHandler: ToolHandler = async (args, ctx) => {
  const docPath = args.path as string | undefined;
  if (!docPath) return makeToolErrorResult("Missing required parameter: path");

  const readOk = await checkDocPermission(ctx.writer, docPath, "read");
  if (!readOk) return makeToolErrorResult(`Permission denied: you do not have read access to "${docPath}".`);

  try {
    const content = await readAssembledDocument(docPath);
    const headSha = await getHeadSha(getDataRoot());
    const structure = await readDocumentStructure(docPath);
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

  const structReadOk = await checkDocPermission(ctx.writer, docPath, "read");
  if (!structReadOk) return makeToolErrorResult(`Permission denied: you do not have read access to "${docPath}".`);

  try {
    const structure = await readDocumentStructure(docPath);

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

  const secReadOk = await checkDocPermission(ctx.writer, docPath, "read");
  if (!secReadOk) return makeToolErrorResult(`Permission denied: you do not have read access to "${docPath}".`);

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

  // Check write permission for all target documents
  const targetDocs = new Set(sections.map((s) => s.doc_path));
  for (const dp of targetDocs) {
    const wpOk = await checkDocPermission(ctx.writer, dp, "write");
    if (!wpOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${dp}".`);
  }

  // Validate all doc_paths before any state is created
  const validationRoot = getContentRoot();
  for (const s of sections) {
    try {
      resolveDocPathUnderContent(validationRoot, s.doc_path);
    } catch (error) {
      if (error instanceof InvalidDocPathError) {
        return makeToolErrorResult(`Invalid doc_path "${s.doc_path}": ${error.message}`);
      }
      throw error;
    }
  }

  const writer = ctx.writer;

  // Check for existing pending proposal
  const existing = await findDraftProposalByWriter(writer.id);
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

  const { id: mcpProposalId, contentRoot } = await createProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
    sections.map((s) => ({
      doc_path: s.doc_path,
      heading_path: s.heading_path,
      justification: s.justification,
    })),
  );

  // Write section content through OverlayContentLayer — skeleton resolution,
  // ancestor auto-creation, and content writing are handled internally.
  // When writeSection auto-splits multi-heading content, it returns expanded targets.
  const overlayLayer = new OverlayContentLayer(contentRoot, getContentRoot());
  let expandedSections: ProposalSection[] = [];

  for (const s of sections) {
    const splitTargets = await overlayLayer.writeSection(SectionRef.fromTarget(s), s.content);
    if (splitTargets) {
      expandedSections.push(...splitTargets.map(t => ({
        doc_path: t.doc_path,
        heading_path: t.heading_path,
      })));
    } else {
      expandedSections.push({ doc_path: s.doc_path, heading_path: s.heading_path });
    }
  }

  // If any section was auto-split, update the proposal's section metadata
  if (expandedSections.length !== sections.length) {
    await updateProposalSections(mcpProposalId, expandedSections);
  }

  // Evaluate immediately (informational — agent must call commit_proposal explicitly)
  const { evaluation, sections: evaluatedSections } = await evaluateProposalHumanInvolvement(mcpProposalId);

  // Broadcast proposal:created so frontends show the pending indicator
  if (ctx.emitEvent && evaluatedSections.length > 0) {
    ctx.emitEvent({
      type: "proposal:draft",
      proposal_id: mcpProposalId,
      doc_path: evaluatedSections[0].doc_path,
      heading_paths: evaluatedSections.map((s) => s.heading_path),
      writer_id: writer.id,
      writer_display_name: writer.displayName,
      intent,
    });
  }

  const outcome = evaluation.all_sections_accepted ? "accepted" : "blocked";
  return jsonToolResult({
    proposal_id: mcpProposalId,
    status: "draft",
    outcome,
    ...(outcome === "blocked" ? {
      block_reason: deriveBlockReason(evaluation),
      per_section_threshold: INVOLVEMENT_THRESHOLD,
    } : {}),
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
    if (proposal.status !== "draft") {
      return makeToolErrorResult(`Cannot commit proposal in ${proposal.status} state.`);
    }

    // Check write permission for all target documents
    const commitTargetDocs = new Set(proposal.sections.map((s) => s.doc_path));
    for (const dp of commitTargetDocs) {
      const wpOk = await checkDocPermission(ctx.writer, dp, "write");
      if (!wpOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${dp}".`);
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);

    if (evaluation.all_sections_accepted) {
      const catalogMutations = await summarizeProposalCatalogMutations(proposal);
      const scores: SectionScoreSnapshot = {};
      for (const s of sections) {
        scores[SectionRef.fromTarget(s).globalKey] = s.humanInvolvement_score;
      }

      const committedHead = await commitProposalToCanonical(proposalId, scores);

      if (ctx.writer.type === "agent") {
        const { agentEventLog } = await import("../agent-event-log.js");
        agentEventLog.append(ctx.writer, { kind: "proposal_committed", proposalId });
      }

      if (ctx.emitEvent) {
        ctx.emitEvent({
          type: "content:committed",
          doc_path: sections[0]?.doc_path ?? catalogMutations.renamed?.newPath ?? catalogMutations.createdDocPaths[0] ?? "",
          sections: sections.map((s) => ({ doc_path: s.doc_path, heading_path: s.heading_path })),
          commit_sha: committedHead,
          writer_id: ctx.writer.id,
          writer_display_name: ctx.writer.displayName,
          writer_type: ctx.writer.type,
          contributor_ids: [ctx.writer.id],
          seconds_ago: 0,
        });
        emitCatalogMutationEvents(ctx.emitEvent, catalogMutations, ctx.writer, committedHead);
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
      if (ctx.writer.type === "agent") {
        const { agentEventLog } = await import("../agent-event-log.js");
        agentEventLog.append(ctx.writer, { kind: "proposal_blocked", proposalId });
      }

      return jsonToolResult({
        proposal_id: proposalId,
        status: "draft",
        outcome: "blocked",
        block_reason: deriveBlockReason(evaluation),
        per_section_threshold: INVOLVEMENT_THRESHOLD,
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
  const validStatuses = ["draft", "committed", "withdrawn"];

  if (status && !validStatuses.includes(status)) {
    return makeToolErrorResult(`Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
  }

  const proposals = await listProposals(status as ProposalStatus | undefined);
  return jsonToolResult({ proposals });
};

// ─── my_proposals ───────────────────────────────────────

const myProposalsHandler: ToolHandler = async (args, ctx) => {
  const status = args.status as string | undefined;
  const validStatuses = ["draft", "committed", "withdrawn"];

  if (status && !validStatuses.includes(status)) {
    return makeToolErrorResult(`Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
  }

  const all = await listProposals(status as ProposalStatus | undefined);
  const mine = all.filter(p => p.writer.id === ctx.writer.id);
  return jsonToolResult({ proposals: mine });
};

// ─── read_proposal ───────────────────────────────────────

const readProposalHandler: ToolHandler = async (args) => {
  const proposalId = args.proposal_id as string | undefined;
  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");

  try {
    const { proposal, sectionContent } = await readProposalWithContent(proposalId);

    // Re-evaluate human-involvement for pending/committing proposals
    let evaluation: import("../../types/shared.js").ProposalHumanInvolvementEvaluation | undefined;
    if (proposal.status === "draft" || proposal.status === "committing") {
      const result = await evaluateProposalHumanInvolvement(proposalId);
      evaluation = result.evaluation;
    }

    // Return content as a separate map, not on section objects
    const contentMap: Record<string, string> = {};
    for (const [key, value] of sectionContent) {
      contentMap[key] = value;
    }

    return jsonToolResult({
      proposal: { ...proposal, ...(evaluation ? { humanInvolvement_evaluation: evaluation } : {}) },
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

  const wsOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!wsOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

  // Validate doc_path before any state is created
  try {
    resolveDocPathUnderContent(getContentRoot(), docPath);
  } catch (error) {
    if (error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Invalid doc_path "${docPath}": ${error.message}`);
    }
    throw error;
  }

  try {
    const proposal = await readProposal(proposalId);
    if (proposal.writer.id !== ctx.writer.id) {
      return makeToolErrorResult("You can only modify your own proposals.");
    }
    if (proposal.status !== "draft") {
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

    // Write section content through OverlayContentLayer
    const overlayLayer = new OverlayContentLayer(updContentRoot, getContentRoot());
    const splitTargets = await overlayLayer.writeSection(new SectionRef(docPath, headingPath), content);

    // If auto-split occurred, update proposal sections with the expanded targets
    if (splitTargets) {
      const remainingSections = updated.sections.filter(
        (s) => !(s.doc_path === docPath && JSON.stringify(s.heading_path) === JSON.stringify(headingPath)),
      );
      const expandedSections = [
        ...remainingSections,
        ...splitTargets.map(t => ({ doc_path: t.doc_path, heading_path: t.heading_path })),
      ];
      await updateProposalSections(proposalId, expandedSections);
    }

    // Broadcast proposal:draft with updated sections (re-read to get current state)
    const broadcastProposal = splitTargets ? await readProposal(proposalId) : updated;
    if (ctx.emitEvent && broadcastProposal.sections.length > 0) {
      ctx.emitEvent({
        type: "proposal:draft",
        proposal_id: broadcastProposal.id,
        doc_path: broadcastProposal.sections[0].doc_path,
        heading_paths: broadcastProposal.sections.map((s) => s.heading_path),
        writer_id: ctx.writer.id,
        writer_display_name: ctx.writer.displayName,
        intent: broadcastProposal.intent,
      });
    }

    const { evaluation, sections } = await evaluateProposalHumanInvolvement(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      status: "draft",
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
      name: "list_documents",
      description: "List readable documents under a canonical root path with lightweight section counts.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: 'Canonical absolute scope path (default "/"). Supports folder or single document paths.' },
        },
      },
    },
    listDocumentsHandler,
  );

  registry.register(
    {
      name: "list_sections",
      description: "List readable sections under a canonical scope without returning body text.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Canonical absolute scope path (default "/"). Supports folder or single document paths.' },
        },
      },
    },
    listSectionsHandler,
  );

  registry.register(
    {
      name: "search_text",
      description: "Run lexical search across canonical readable section bodies using literal or regular-expression syntax.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern." },
          syntax: { type: "string", enum: ["literal", "regexp"], description: "Search syntax mode." },
          root: { type: "string", description: 'Canonical absolute scope path (default "/"). Supports folder or single document paths.' },
          case_sensitive: { type: "boolean", description: "Whether matching is case-sensitive (default false)." },
          max_results: { type: "number", description: "Global max number of matches to return (default 20)." },
          context_bytes: { type: "number", description: "Approximate byte context around each match (default 100)." },
        },
        required: ["pattern", "syntax"],
      },
    },
    searchTextHandler,
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
                doc_path: { type: "string", description: "Document path (must end with .md)" },
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
          doc_path: { type: "string", description: "Document path (must end with .md)" },
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
