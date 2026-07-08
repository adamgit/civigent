/**
 * Tier 3 MCP tools — collaboration surface with explicit proposals.
 *
 * Tools: list_documents, list_sections, search_text,
 *        read_doc, read_doc_structure, read_published_section, read_proposal_section,
 *        create_proposal, publish_proposal, withdraw_proposal,
 *        list_proposals, read_proposal, write_proposal_section
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult, jsonBlockedToolResult } from "../tool-registry.js";
import { makeToolErrorResult } from "../protocol.js";
import { readAssembledDocument, DocumentNotFoundError } from "../../storage/document-reader.js";
import { readSectionWithHeading, SectionNotFoundError } from "../../storage/section-reader.js";
import { getContentRoot, getDataRoot } from "../../storage/data-root.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
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
  listAllProposals,
  listDraftProposals,
  listCommittedProposals,
  listWithdrawnProposals,
  findDraftProposalByWriter,
  transitionToWithdrawn,
  isProposalMutable,
  isCrdtOwnedProposal,
  ProposalNotFoundError,
  InvalidProposalStateError,
} from "../../storage/proposal-repository.js";
import {
  evaluateAgentWritePolicy,
  commitProposalToCanonical,
} from "../../storage/commit-pipeline.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { agentWritePolicyToolBody } from "./agent-write-policy-body.js";
import { SectionRef } from "../../domain/section-ref.js";
import { InvalidDocPathError, resolveDocPathUnderContent } from "../../storage/path-utils.js";
import type { HumanInvolvementPolicyResult } from "../../types/shared.js";
import { buildFragmentContent, fragmentFromBodyHolder, sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
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

// Agent-write-policy MCP response shaping lives in `agent-write-policy-body.ts`
// (shared with structural.ts / filesystem.ts) as `agentWritePolicyToolBody`.

// ─── discovery/search ────────────────────────────────────

const listDocumentsHandler: ToolHandler = async (args, ctx) => {
  const root = args.root as string | undefined;
  try {
    const { rows, failures } = await listReadableDocuments(ctx.writer, root);
    // Surface per-row read failures explicitly (claim-review 04) — never drop them.
    return jsonToolResult({ documents: rows, ...(failures.length > 0 ? { failures } : {}) });
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
    const { rows, failures } = await listReadableSections(ctx.writer, pathScope);
    // Surface per-row read failures explicitly (claim-review 04) — never drop them.
    return jsonToolResult({ sections: rows, ...(failures.length > 0 ? { failures } : {}) });
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
    const result = await searchReadableText(ctx.writer, {
      pattern,
      syntax,
      root: args.root as string | undefined,
      case_sensitive: args.case_sensitive as boolean | undefined,
      max_results: args.max_results as number | undefined,
      context_bytes: args.context_bytes as number | undefined,
    });
    return jsonToolResult(result);
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

// ─── read_published_section ──────────────────────────────

const readPublishedSectionHandler: ToolHandler = async (args, ctx) => {
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

  // Draft limit: tier-3 agents (collaboration tools) may have multiple drafts.
  // replace=true auto-withdraws the most recent existing draft for convenience.
  const replaceFlag = args.replace as boolean | undefined;
  if (replaceFlag) {
    const existing = await findDraftProposalByWriter(writer.id);
    if (existing) {
      await transitionToWithdrawn(existing.id, "auto-withdrawn by replace flag");
    }
  }

  const { id: mcpProposalId } = await createProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    intent,
    sections.map((s) => ({
      doc_path: s.doc_path,
      heading_path: s.heading_path,
      justification: s.justification,
    })),
  );

  // Write section content AND derive the manifest from the REAL parser-expanded
  // write result through the single manifest-owning boundary (Claim 3): when a
  // payload contains embedded headings that expand into real sections, the
  // manifest records all of them, not just the originally-requested target.
  for (const s of sections) {
    // Pass the RAW declared doc_path/heading_path (matching the form `createProposal`
    // stored) so manifest derivation dedups against the declared section and
    // preserves its justification (the agent-write-policy bypass, spec 12).
    const heading = s.heading_path.length === 0 ? "" : s.heading_path[s.heading_path.length - 1]!;
    await mutateProposalContent(mcpProposalId, {
      kind: "write_section",
      docPath: s.doc_path,
      headingPath: s.heading_path,
      heading,
      content: sectionWriteInputFromExternal(s.content),
      justification: s.justification,
    });
  }

  // Evaluate immediately (informational — agent must call publish_proposal explicitly)
  const policyResult = await evaluateAgentWritePolicy(mcpProposalId);

  // Broadcast proposal:draft so frontends can show the active draft indicator
  if (ctx.emitEvent && policyResult.targets.length > 0) {
    ctx.emitEvent({
      type: "proposal:draft",
      proposal_id: mcpProposalId,
      doc_path: policyResult.targets[0].target.doc_path,
      heading_paths: policyResult.targets
        .map((t) => t.target)
        .filter((tt) => tt.kind === "section")
        .map((tt) => (tt as { heading_path: string[] }).heading_path),
      writer_id: writer.id,
      writer_display_name: writer.displayName,
      intent,
    });
  }

  if (!policyResult.canWrite) {
    return jsonBlockedToolResult(policyResult.message, {
      proposal_id: mcpProposalId,
      status: "draft",
      agent_write_policy: agentWritePolicyToolBody(policyResult),
    });
  }
  return jsonToolResult({
    proposal_id: mcpProposalId,
    status: "draft",
    outcome: "accepted",
    agent_write_policy: agentWritePolicyToolBody(policyResult),
  });
};

// ─── publish_proposal ────────────────────────────────────

const publishProposalHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");

  try {
    const proposal = await readProposal(proposalId);

    if (proposal.writer.id !== ctx.writer.id) {
      return makeToolErrorResult("You can only publish your own proposals.");
    }
    if (proposal.status !== "draft") {
      return makeToolErrorResult(`Cannot publish proposal in ${proposal.status} state.`);
    }

    // Check write permission for all target documents
    const commitTargetDocs = new Set(proposal.sections.map((s) => s.doc_path));
    for (const dp of commitTargetDocs) {
      const wpOk = await checkDocPermission(ctx.writer, dp, "write");
      if (!wpOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${dp}".`);
    }

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    if (policyResult.canWrite) {
      const catalogMutations = await summarizeProposalCatalogMutations(proposal);
      const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);
      const sections = proposal.sections;

      const committedHead = await commitProposalToCanonical(proposalId, committedMetadata);

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
        agent_write_policy: agentWritePolicyToolBody(policyResult),
      });
    } else {
      if (ctx.writer.type === "agent") {
        const { agentEventLog } = await import("../agent-event-log.js");
        agentEventLog.append(ctx.writer, { kind: "proposal_blocked", proposalId });
      }

      return jsonBlockedToolResult(policyResult.message, {
        proposal_id: proposalId,
        status: "draft",
        agent_write_policy: agentWritePolicyToolBody(policyResult),
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

// ─── withdraw_proposal ───────────────────────────────────

const withdrawProposalHandler: ToolHandler = async (args, ctx) => {
  const proposalId = args.proposal_id as string | undefined;
  const reason = args.reason as string | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");

  try {
    const proposal = await readProposal(proposalId);
    if (proposal.writer.id !== ctx.writer.id) {
      return makeToolErrorResult("You can only withdraw your own proposals.");
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

  const all = status === "draft"
    ? await listDraftProposals()
    : status === "committed"
    ? await listCommittedProposals()
    : status === "withdrawn"
    ? await listWithdrawnProposals()
    : await listAllProposals();
  // Hide CRDT-owned (DocSession live-edit) proposals from the agent surface:
  // they are system artefacts, not agent-authored proposals, and must not be a
  // live-state side channel (spec 10 "One active proposal per DocSession").
  const proposals = all.filter((p) => !isCrdtOwnedProposal(p));
  return jsonToolResult({ proposals });
};

// ─── my_proposals ───────────────────────────────────────

const myProposalsHandler: ToolHandler = async (args, ctx) => {
  const status = args.status as string | undefined;
  const validStatuses = ["draft", "committed", "withdrawn"];

  if (status && !validStatuses.includes(status)) {
    return makeToolErrorResult(`Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
  }

  const all = status === "draft"
    ? await listDraftProposals()
    : status === "committed"
    ? await listCommittedProposals()
    : status === "withdrawn"
    ? await listWithdrawnProposals()
    : await listAllProposals();
  // Filter to this writer's own proposals AND hide CRDT-owned (DocSession
  // live-edit) proposals — those are system artefacts, never agent-authored.
  const mine = all.filter((p) => p.writer.id === ctx.writer.id && !isCrdtOwnedProposal(p));
  return jsonToolResult({ proposals: mine });
};

// ─── read_proposal ───────────────────────────────────────

const readProposalHandler: ToolHandler = async (args) => {
  const proposalId = args.proposal_id as string | undefined;
  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");

  try {
    // Refuse CRDT-owned (DocSession live-edit) proposals: they are system
    // artefacts mutated internally by the DocSession actor, not an agent-
    // readable proposal surface. Reading one here would turn read_proposal into
    // a live-state side channel (spec 10 "One active proposal per DocSession").
    // Resolve metadata first (cheap) to make the ownership decision without
    // materializing the live-edit content.
    const meta = await readProposal(proposalId);
    if (isCrdtOwnedProposal(meta)) {
      return makeToolErrorResult(
        `Proposal ${proposalId} is owned by a live editing session and is not readable through the agent proposal surface. `
          + `Its content reflects in-flight collaborative edits that are managed by the live document session, not an authored proposal. `
          + `To see what is currently published, read the document directly with read_doc, read_doc_structure, or read_published_section. `
          + `To track or author your own proposals, use my_proposals, list_proposals, or create_proposal.`,
      );
    }

    const { proposal, sectionContent } = await readProposalWithContent(proposalId);

    // Re-evaluate agent write policy for draft/committing proposals
    let agentWritePolicy: HumanInvolvementPolicyResult | undefined;
    if (proposal.status === "draft" || proposal.status === "committing") {
      agentWritePolicy = await evaluateAgentWritePolicy(proposalId);
    }

    // Return content as a separate map, not on section objects
    const contentMap: Record<string, string> = {};
    for (const [key, value] of sectionContent) {
      contentMap[key] = value;
    }

    return jsonToolResult({
      proposal: {
        ...proposal,
        ...(agentWritePolicy ? { agent_write_policy: agentWritePolicyToolBody(agentWritePolicy) } : {}),
      },
      section_content: contentMap,
    });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return makeToolErrorResult(`Proposal not found: ${proposalId}`);
    }
    throw error;
  }
};

// ─── read_proposal_section ───────────────────────────────

const readProposalSectionHandler: ToolHandler = async (args) => {
  const proposalId = args.proposal_id as string | undefined;
  const docPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!docPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath)) return makeToolErrorResult("Missing required parameter: heading_path (array of strings)");

  try {
    const proposal = await readProposal(proposalId);
    const reader = ProposalReader.open(proposal.id, proposal.status);
    const body = await reader.readSection(docPath, headingPath);

    let content;
    if (headingPath.length === 0) {
      content = fragmentFromBodyHolder(body);
    } else {
      const section = (await reader.getSectionList(docPath)).find((entry) =>
        entry.headingPath.length === headingPath.length
        && entry.headingPath.every((segment, index) => segment === headingPath[index]),
      );
      if (!section) {
        return makeToolErrorResult(`Section not found: ${headingPath.join(" > ")} in proposal ${proposalId}`);
      }
      content = buildFragmentContent(body, section.level, section.heading);
    }

    return jsonToolResult({
      proposal_id: proposalId,
      status: proposal.status,
      doc_path: docPath,
      heading_path: headingPath,
      content,
    });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return makeToolErrorResult(`Proposal not found: ${proposalId}`);
    }
    if (error instanceof SectionNotFoundError || error instanceof HeadingNotFoundError) {
      return makeToolErrorResult(`Section not found: ${headingPath.join(" > ")} in ${docPath}`);
    }
    if (error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Invalid document path: ${docPath}`);
    }
    throw error;
  }
};

// ─── write_proposal_section ──────────────────────────────

const writeProposalSectionHandler: ToolHandler = async (args, ctx) => {
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
    if (!isProposalMutable(proposal)) {
      return makeToolErrorResult(`Cannot modify proposal in ${proposal.status} state.`);
    }

    // Write section content AND derive the manifest from the REAL parser-expanded
    // write result through the single manifest-owning boundary (Claim 3). This
    // restores post-split section expansion into the manifest: when the payload
    // contains embedded headings that expand into real sections, the manifest now
    // records all of them rather than only the originally-requested target.
    const heading = headingPath.length === 0 ? "" : headingPath[headingPath.length - 1]!;
    const { proposal: updated } = await mutateProposalContent(proposalId, {
      kind: "write_section",
      docPath,
      headingPath,
      heading,
      content: sectionWriteInputFromExternal(content),
      justification,
    });

    const broadcastProposal = updated;
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

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    return jsonToolResult({
      proposal_id: proposalId,
      status: "draft",
      agent_write_policy: agentWritePolicyToolBody(policyResult),
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
    "listDocuments",
    {
      name: "list_documents",
      description: "List readable documents under a live scope path with lightweight section counts.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: 'Live absolute scope path (default "/"). Supports folder or single document paths.' },
        },
      },
    },
    listDocumentsHandler,
  );

  registry.register(
    "listSections",
    {
      name: "list_sections",
      description: "List readable sections under a live scope without returning body text.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Live absolute scope path (default "/"). Supports folder or single document paths.' },
        },
      },
    },
    listSectionsHandler,
  );

  registry.register(
    "searchText",
    {
      name: "search_text",
      description: "Run lexical search across live readable section bodies using literal or regular-expression syntax.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern." },
          syntax: { type: "string", enum: ["literal", "regexp"], description: "Search syntax mode." },
          root: { type: "string", description: 'Live absolute scope path (default "/"). Supports folder or single document paths.' },
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
    "readDoc",
    {
      name: "read_doc",
      description: "Read the full live markdown content of a document, including its heading structure.",
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
    "readDocStructure",
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
    "readPublishedSection",
    {
      name: "read_published_section",
      description: "Read the published/live (canonical) content of a specific section. This reads the published system and will NOT show proposal-only edits. To read a section as it appears inside a proposal (draft/committed/withdrawn), use read_proposal_section instead.",
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
    readPublishedSectionHandler,
  );

  registry.register(
    "createProposal",
    {
      name: "create_proposal",
      description: "Create a new proposal with intent and section changes. The proposal starts in draft status. Use publish_proposal to publish it.",
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
          replace: { type: "boolean", description: "Auto-withdraw an existing draft proposal if one exists" },
        },
        required: ["intent", "sections"],
      },
    },
    createProposalHandler,
  );

  registry.register(
    "writeProposalSection",
    {
      name: "write_proposal_section",
      description: "Replace the content at the specified heading path within an existing draft proposal. Creates the section and any missing ancestors if needed.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "ID of the draft proposal" },
          doc_path: { type: "string", description: "Document path (must end with .md)" },
          heading_path: { type: "array", items: { type: "string" }, description: "Section heading path" },
          content: { type: "string", description: "Section content (markdown). Describes the section as the user wants it to read after the call." },
          justification: { type: "string", description: "Optional justification for overwriting this section" },
        },
        required: ["proposal_id", "doc_path", "heading_path", "content"],
      },
    },
    writeProposalSectionHandler,
  );

  registry.register(
    "publishProposal",
    {
      name: "publish_proposal",
      description: "Attempt to publish a draft proposal to the live wiki. If any sections are blocked, the proposal remains draft.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "ID of the proposal to commit" },
        },
        required: ["proposal_id"],
      },
    },
    publishProposalHandler,
  );

  registry.register(
    "withdrawProposal",
    {
      name: "withdraw_proposal",
      description: "Withdraw/cancel a draft proposal. The proposal moves to withdrawn state and cannot be modified further.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "ID of the proposal to cancel" },
          reason: { type: "string", description: "Optional reason for cancellation" },
        },
        required: ["proposal_id"],
      },
    },
    withdrawProposalHandler,
  );

  registry.register(
    "listProposals",
    {
      name: "list_proposals",
      description: "List proposals, optionally filtered by status.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status: draft, committed, or withdrawn" },
        },
      },
    },
    listProposalsHandler,
  );

  registry.register(
    "myProposals",
    {
      name: "my_proposals",
      description: "List your own proposals, optionally filtered by status. Preferred way to check your proposal state.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status: draft, committed, or withdrawn" },
        },
      },
    },
    myProposalsHandler,
  );

  registry.register(
    "readProposal",
    {
      name: "read_proposal",
      description: "Read the details of a specific proposal, including its sections, content, and human-involvement evaluation.",
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

  registry.register(
    "readProposalSection",
    {
      name: "read_proposal_section",
      description: "Read a specific section as it appears inside a proposal.",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string", description: "Proposal ID" },
          doc_path: { type: "string", description: "Document path" },
          heading_path: {
            type: "array",
            items: { type: "string" },
            description: "Heading path as array of heading names, e.g. ['Getting Started', 'Installation']",
          },
        },
        required: ["proposal_id", "doc_path", "heading_path"],
      },
    },
    readProposalSectionHandler,
  );

  // Renamed wire names — a call to one returns a migration message, not an
  // unknown-tool error. `commit_proposal` was renamed to `publish_proposal`.
  registry.deprecate("commit_proposal");
}
