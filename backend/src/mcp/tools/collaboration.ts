/**
 * Tier 3 MCP tools — collaboration surface with explicit proposals.
 *
 * Tools: list_documents, list_sections, search_text,
 *        read_doc, read_published_section, read_proposal_section,
 *        create_proposal, publish_proposal, withdraw_proposal,
 *        list_proposals, read_proposal, write_proposal_section
 *
 * Temporarily deprecated (not registered): read_doc_structure → use list_sections.
 */

import type { ToolRegistry, ToolHandler } from "../tool-registry.js";
import { jsonToolResult, textToolResult, jsonBlockedToolResult } from "../tool-registry.js";
import { AgentPayloadContract } from "../agent-payload-contract.js";
import { makeToolErrorResult, parseToolArgumentDocPath } from "../protocol.js";
import { readAssembledDocument, DocumentNotFoundError } from "../../storage/document-reader.js";
import { readSectionWithHeading, SectionNotFoundError } from "../../storage/section-reader.js";
import { ProposalReader } from "../../storage/proposal-reader.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import {
  readDocumentStructure,
  flattenStructureToHeadingPaths,
  HeadingNotFoundError,
} from "../../storage/heading-resolver.js";
import {
  createProposal,
  readProposal,
  resolveProposalSectionClaims,
  listProposalsToleratingUndecodable,
  transitionToWithdrawn,
  isProposalMutable,
  isCrdtOwnedProposal,
  ProposalNotFoundError,
  InvalidProposalStateError,
} from "../../storage/proposal-repository.js";
import {
  evaluateAgentWritePolicy,
  publishProposalToCanonicalDetailed,
} from "../../storage/commit-pipeline.js";
import { propagateCommitToLiveSessions } from "../../ws/crdt-ws-coordinator.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";
import { agentWritePolicyToolBody } from "./agent-write-policy-body.js";
import {
  rememberSessionDraft,
  forgetSessionDraft,
  takeCurrentSessionDraft,
  listSessionCreatedProposals,
} from "../session-drafts.js";
import { SectionRef } from "../../domain/section-ref.js";
import { findProseUnicodeEscapes } from "../../domain/encoding-defect-detection.js";
import { InvalidDocPathError } from "../../storage/path-utils.js";
import type { DocPath, HumanInvolvementPolicyResult, ProposalStatus } from "../../types/shared.js";
import { buildFragmentContent, fragmentFromBodyHolder, sectionWriteInputFromExternal } from "../../storage/section-formatting.js";
import { checkDocPermission } from "../../auth/acl.js";
import { authorizeDocRead, PermissionError } from "../../auth/authorized-read.js";
import { emitCatalogMutationEvents, summarizeProposalCatalogMutations } from "../catalog-events.js";
import { emitProposalDraftEventsByDoc, emitContentCommittedEventsByDoc } from "../../api/application/events.js";
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

    // Broadcast agent:reading per document whose section inventory was returned
    // (same signal REST GET /canonical/.../sections emits). Folder/root scopes
    // fan out one event per touched document.
    if (ctx.writer.type === "agent" && ctx.emitEvent) {
      const headingPathsByDoc = new Map<string, string[][]>();
      for (const row of rows) {
        let headingPaths = headingPathsByDoc.get(row.doc_path);
        if (!headingPaths) {
          headingPaths = [];
          headingPathsByDoc.set(row.doc_path, headingPaths);
        }
        headingPaths.push(row.heading_path);
      }
      for (const [docPath, headingPaths] of headingPathsByDoc) {
        ctx.emitEvent({
          type: "agent:reading",
          actor_id: ctx.writer.id,
          actor_display_name: ctx.writer.displayName,
          doc_path: docPath,
          heading_paths: headingPaths,
        });
      }
    }

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
  const rawDocPath = args.path as string | undefined;
  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: path");

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  let authorizedRead;
  try {
    authorizedRead = await authorizeDocRead(ctx.writer, docPath);
  } catch (error) {
    if (error instanceof PermissionError) {
      return makeToolErrorResult(`Permission denied: you do not have read access to "${docPath}".`);
    }
    throw error;
  }

  try {
    const content = await readAssembledDocument(authorizedRead);
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

    return textToolResult(content);
  } catch (error) {
    if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
      return makeToolErrorResult(`Document not found: ${docPath}`);
    }
    throw error;
  }
};

// ─── read_doc_structure (temporarily disabled on MCP surface) ──
// Production trial: keep the handler for quick restore; agents should use
// list_sections. Wire name is registered via registry.deprecate(...).
//
// const readDocStructureHandler: ToolHandler = async (args, ctx) => {
//   const docPath = args.path as string | undefined;
//   if (!docPath) return makeToolErrorResult("Missing required parameter: path");
//
//   const structReadOk = await checkDocPermission(ctx.writer, docPath, "read");
//   if (!structReadOk) return makeToolErrorResult(`Permission denied: you do not have read access to "${docPath}".`);
//
//   try {
//     const structure = await readDocumentStructure(docPath);
//
//     // Broadcast agent:reading
//     if (ctx.writer.type === "agent" && ctx.emitEvent) {
//       const headingPaths = flattenStructureToHeadingPaths(structure);
//       ctx.emitEvent({
//         type: "agent:reading",
//         actor_id: ctx.writer.id,
//         actor_display_name: ctx.writer.displayName,
//         doc_path: docPath,
//         heading_paths: headingPaths,
//       });
//     }
//
//     return jsonToolResult({ doc_path: docPath, structure });
//   } catch (error) {
//     if (error instanceof DocumentNotFoundError || error instanceof InvalidDocPathError) {
//       return makeToolErrorResult(`Document not found: ${docPath}`);
//     }
//     throw error;
//   }
// };

// ─── read_published_section ──────────────────────────────

const readPublishedSectionHandler: ToolHandler = async (args, ctx) => {
  const rawDocPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;

  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath)) return makeToolErrorResult("Missing required parameter: heading_path (array of strings)");

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  let authorizedRead;
  try {
    authorizedRead = await authorizeDocRead(ctx.writer, docPath);
  } catch (error) {
    if (error instanceof PermissionError) {
      return makeToolErrorResult(`Permission denied: you do not have read access to "${docPath}".`);
    }
    throw error;
  }

  try {
    const content = await readSectionWithHeading(authorizedRead, headingPath);

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

    return textToolResult(content);
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
  const rawSections = args.sections as Array<{
    doc_path: string;
    heading_path: string[];
    content: string;
    justification?: string;
  }> | undefined;

  if (!intent) return makeToolErrorResult("Missing required parameter: intent");
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    return makeToolErrorResult("Missing required parameter: sections (non-empty array)");
  }

  const sections: Array<{
    doc_path: DocPath;
    heading_path: string[];
    content: string;
    justification?: string;
  }> = [];
  for (const s of rawSections) {
    if (!s.doc_path || !Array.isArray(s.heading_path) || typeof s.content !== "string") {
      return makeToolErrorResult("Each section must have doc_path (string), heading_path (string[]), and content (string)");
    }
    const parsedSectionDocPath = parseToolArgumentDocPath(s.doc_path);
    if ("errorResult" in parsedSectionDocPath) return parsedSectionDocPath.errorResult;
    sections.push({ ...s, doc_path: parsedSectionDocPath.docPath });
  }

  for (const s of sections) {
    const refused = AgentPayloadContract.refuseMalformedMarkdown(s.content);
    if (refused) return refused;
  }

  // Check write permission for all target documents
  const targetDocs = new Set(sections.map((s) => s.doc_path));
  for (const dp of targetDocs) {
    const wpOk = await checkDocPermission(ctx.writer, dp, "write");
    if (!wpOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${dp}".`);
  }

  const writer = ctx.writer;

  // Draft limit: tier-3 agents (collaboration tools) may have multiple drafts.
  // replace=true auto-withdraws the most recent existing draft for convenience.
  // Capture the withdrawn id so the response can make the ID switch unmissable —
  // weak models keep the old id in working memory otherwise (Area M footgun).
  const replaceFlag = args.replace as boolean | undefined;
  let withdrawnProposalId: string | null = null;
  if (replaceFlag) {
    // Session-LOCAL affinity: only withdraw the most recent draft remembered by
    // THIS session's in-memory state — never another concurrent conversation's
    // draft under the same agent credential, and never a draft this session's
    // memory no longer knows about (after TTL/restart, use explicit proposal_id).
    const existing = await takeCurrentSessionDraft(ctx.session, writer.id);
    if (existing) {
      await transitionToWithdrawn(existing.id, "auto-withdrawn by replace flag");
      withdrawnProposalId = existing.id;
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
  rememberSessionDraft(ctx.session, mcpProposalId);

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
  emitProposalDraftEventsByDoc(
    ctx.emitEvent,
    mcpProposalId,
    writer,
    intent,
    policyResult.targets.map((t) => t.target),
  );

  // When replace=true actually withdrew a prior draft, make the ID switch
  // unmissable: the old id is permanently dead and ONLY the new id may be used.
  // Omitted entirely when no prior draft existed (do not claim a withdrawal).
  const withdrawalNote = withdrawnProposalId
    ? `Your previous draft ${withdrawnProposalId} was permanently withdrawn by replace: true — discard that id. ` +
      `Only proposal_id ${mcpProposalId} may be used for further write_proposal_section / publish_proposal calls.`
    : null;

  if (!policyResult.canWrite) {
    return jsonBlockedToolResult(
      withdrawalNote ? `${policyResult.message} ${withdrawalNote}` : policyResult.message,
      {
        proposal_id: mcpProposalId,
        status: "draft",
        agent_write_policy: agentWritePolicyToolBody(policyResult),
        ...(withdrawnProposalId ? { withdrawn_proposal_id: withdrawnProposalId } : {}),
      },
    );
  }
  const normalizationNote = AgentPayloadContract.noteForNormalizedWrite(
    sections.map((s) => s.content),
    "read_proposal_section",
  );

  return jsonToolResult({
    proposal_id: mcpProposalId,
    status: "draft",
    outcome: "accepted",
    agent_write_policy: agentWritePolicyToolBody(policyResult),
    ...(withdrawnProposalId ? { withdrawn_proposal_id: withdrawnProposalId } : {}),
    ...(withdrawalNote ? { message: withdrawalNote } : {}),
    ...(normalizationNote ? { normalization_note: normalizationNote } : {}),
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

    const { claims } = await resolveProposalSectionClaims(proposalId);
    const offendingSections: Array<{ docPath: string; headingPath: string[]; sequences: string[] }> = [];
    for (const claim of claims) {
      if (claim.state !== "present") continue;
      const sequences = findProseUnicodeEscapes(claim.content);
      if (sequences.length > 0) {
        offendingSections.push({ docPath: claim.docPath, headingPath: claim.headingPath, sequences });
      }
    }
    if (offendingSections.length > 0) {
      return AgentPayloadContract.refuseProseEscapesAtPublish(offendingSections);
    }

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    if (policyResult.canWrite) {
      const catalogMutations = await summarizeProposalCatalogMutations(proposal);
      const committedMetadata = AgentWritePolicy.buildCommittedProposalMetadata(policyResult);

      const absorbResult = await publishProposalToCanonicalDetailed(proposalId, committedMetadata);
      const committedHead = absorbResult.commitSha;
      forgetSessionDraft(ctx.session, proposalId);

      if (ctx.writer.type === "agent") {
        const { agentEventLog } = await import("../agent-event-log.js");
        agentEventLog.append(ctx.writer, { kind: "proposal_committed", proposalId });
      }

      await propagateCommitToLiveSessions(absorbResult, proposalId);

      if (ctx.emitEvent) {
        emitContentCommittedEventsByDoc(
          ctx.emitEvent,
          ctx.writer,
          [ctx.writer.id],
          committedHead,
          proposal.targets,
        );
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
    forgetSessionDraft(ctx.session, proposalId);

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

  const statuses: ProposalStatus[] | undefined =
    status === "draft" || status === "committed" || status === "withdrawn"
      ? [status]
      : undefined;
  const { proposals: listed } = await listProposalsToleratingUndecodable(statuses);
  // Hide CRDT-owned (DocSession live-edit) proposals from the agent surface:
  // they are system artefacts, not agent-authored proposals, and must not be a
  // live-state side channel (spec 10 "One active proposal per DocSession").
  // Undecodable metas are omitted here — agents cannot act on them; admins see
  // them via GET /api/proposals and /api/proposals/degraded.
  const proposals = listed.filter((p) => !isCrdtOwnedProposal(p));
  return jsonToolResult({ proposals });
};

// ─── my_proposals ───────────────────────────────────────

const myProposalsHandler: ToolHandler = async (args, ctx) => {
  const status = args.status as string | undefined;
  const validStatuses = ["draft", "committed", "withdrawn"];

  if (status && !validStatuses.includes(status)) {
    return makeToolErrorResult(`Invalid status filter. Must be one of: ${validStatuses.join(", ")}`);
  }

  // Session-local focus list: only proposals THIS MCP session created, from
  // in-memory session state (task 858) — parallel conversations under one
  // agent credential never see each other's focus list, and proposals carry no
  // session identity. Status comes live from storage, so a remembered draft
  // published/withdrawn from anywhere still filters correctly. After TTL /
  // DELETE / restart the memory is empty and this returns [] — the proposals
  // survive on disk, reachable via `list_proposals` or explicit `proposal_id`.
  const remembered = await listSessionCreatedProposals(ctx.session);
  const mine = remembered.filter(
    (p) =>
      p.writer.id === ctx.writer.id
      && !isCrdtOwnedProposal(p)
      && (!status || p.status === status),
  );
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
          + `To see what is currently published, read the document directly with read_doc, list_sections, or read_published_section. `
          + `To track or author your own proposals, use my_proposals, list_proposals, or create_proposal.`,
      );
    }

    const { proposal, claims } = await resolveProposalSectionClaims(proposalId);

    // Re-evaluate agent write policy for draft/committing proposals
    let agentWritePolicy: HumanInvolvementPolicyResult | undefined;
    if (proposal.status === "draft" || proposal.status === "committing") {
      agentWritePolicy = await evaluateAgentWritePolicy(proposalId);
    }

    // Return content as a separate map, not on section objects
    const contentMap: Record<string, string> = {};
    const absentSectionClaims: Array<{ doc_path: string; heading_path: string[] }> = [];
    for (const claim of claims) {
      if (claim.state === "present") {
        contentMap[new SectionRef(claim.docPath, claim.headingPath).globalKey] = claim.content;
      } else {
        absentSectionClaims.push({ doc_path: claim.docPath, heading_path: claim.headingPath });
      }
    }

    return jsonToolResult({
      proposal: {
        ...proposal,
        ...(agentWritePolicy ? { agent_write_policy: agentWritePolicyToolBody(agentWritePolicy) } : {}),
      },
      section_content: contentMap,
      absent_section_claims: absentSectionClaims,
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
  const rawDocPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath)) return makeToolErrorResult("Missing required parameter: heading_path (array of strings)");

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  try {
    const proposal = await readProposal(proposalId);
    const reader = ProposalReader.open(proposal.id, proposal.status);
    const lookup = await reader.lookupEffectiveSection(docPath, headingPath);
    if (lookup.state === "absent") {
      return makeToolErrorResult(`Section not found: ${headingPath.join(" > ")} in ${docPath}`);
    }

    const content = headingPath.length === 0
      ? fragmentFromBodyHolder(lookup.body)
      : buildFragmentContent(lookup.body, lookup.headingLevel, lookup.heading);

    return textToolResult(content);
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return makeToolErrorResult(`Proposal not found: ${proposalId}`);
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
  const rawDocPath = args.doc_path as string | undefined;
  const headingPath = args.heading_path as string[] | undefined;
  const content = args.content as string | undefined;
  const justification = args.justification as string | undefined;

  if (!proposalId) return makeToolErrorResult("Missing required parameter: proposal_id");
  if (!rawDocPath) return makeToolErrorResult("Missing required parameter: doc_path");
  if (!Array.isArray(headingPath)) return makeToolErrorResult("Missing required parameter: heading_path");
  if (content === undefined) return makeToolErrorResult("Missing required parameter: content");

  const refused = AgentPayloadContract.refuseMalformedMarkdown(args.content);
  if (refused) return refused;

  const parsedDocPath = parseToolArgumentDocPath(rawDocPath);
  if ("errorResult" in parsedDocPath) return parsedDocPath.errorResult;
  const docPath = parsedDocPath.docPath;

  const wsOk = await checkDocPermission(ctx.writer, docPath, "write");
  if (!wsOk) return makeToolErrorResult(`Permission denied: you do not have write access to "${docPath}".`);

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

    emitProposalDraftEventsByDoc(ctx.emitEvent, updated.id, ctx.writer, updated.intent, updated.targets);

    const policyResult = await evaluateAgentWritePolicy(proposalId);

    const normalizationNote = AgentPayloadContract.noteForNormalizedWrite(
      [content],
      "read_proposal_section",
    );

    return jsonToolResult({
      proposal_id: proposalId,
      status: "draft",
      agent_write_policy: agentWritePolicyToolBody(policyResult),
      ...(normalizationNote ? { normalization_note: normalizationNote } : {}),
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
      description:
        "Run lexical search across live readable documents using literal or regular-expression syntax. Matches section bodies, section headings, document filenames, and folder path segments; every result carries a `kind` of body, heading, filename, or path_segment. For path_segment results the returned path is the matched folder prefix, not a document.",
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
      description: "Read the full live content of a document. The response IS the document's raw markdown — no JSON envelope. For a heading inventory, use list_sections.",
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

  // Temporarily disabled on the MCP surface (production trial): agents should use
  // list_sections instead. Handler kept above so we can restore registration quickly.
  // registry.register(
  //   "readDocStructure",
  //   {
  //     name: "read_doc_structure",
  //     description: "Read the heading structure of a document without fetching body content. Useful for understanding document organization before reading specific sections.",
  //     inputSchema: {
  //       type: "object",
  //       properties: {
  //         path: { type: "string", description: "Document path" },
  //       },
  //       required: ["path"],
  //     },
  //   },
  //   readDocStructureHandler,
  // );

  registry.register(
    "readPublishedSection",
    {
      name: "read_published_section",
      description: "Read the published/live (canonical) content of a specific section. The response IS the section's raw markdown (heading line + body) — no JSON envelope. This reads the published system and will NOT show proposal-only edits. To read a section as it appears inside a proposal (draft/committed/withdrawn), use read_proposal_section instead.",
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
      description:
        "Create a new proposal with intent and section changes. The proposal starts in draft status. " +
        "For large edits, prefer a SMALL create_proposal (one or a few sections) followed by repeated " +
        "write_proposal_section calls on the returned proposal_id, rather than one create_proposal " +
        "carrying a giant sections payload — big tool-call JSON is error-prone and hard to retry. " +
        "When the draft is complete, call publish_proposal with the returned proposal_id to publish it.",
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
                content: { type: "string", description: "Section content. The value is markdown containing the real characters the section should read as; a \\uXXXX escape sequence in prose is refused — write escape sequences inside inline code or a fenced code block." },
                justification: { type: "string", description: "Optional justification for overwriting this section" },
              },
              required: ["doc_path", "heading_path", "content"],
            },
            description: "Sections to create or overwrite",
          },
          replace: {
            type: "boolean",
            description:
              "When true, creates a NEW proposal with a NEW proposal_id and PERMANENTLY withdraws the " +
              "most recent draft this session created, as remembered by the server's IN-MEMORY session " +
              "state — you must discard the withdrawn id. That memory is session-local convenience only: " +
              "it is lost when the session expires, is deleted, or the server restarts, after which " +
              "replace withdraws nothing and prior drafts must be managed explicitly by proposal_id " +
              "(write_proposal_section / publish_proposal / withdraw_proposal — drafts always survive " +
              "session loss). A draft created by another session or another agent is never touched. " +
              "Do NOT use replace to update section content: to change an existing draft, " +
              "call write_proposal_section on its proposal_id instead. Omit or false is the normal path " +
              "(creates an additional draft without withdrawing anything).",
          },
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
          content: { type: "string", description: "Section content (markdown). Describes the section as the user wants it to read after the call. The value is markdown containing the real characters the section should read as; a \\uXXXX escape sequence in prose is refused — write escape sequences inside inline code or a fenced code block." },
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
      description: "List the proposals created in THIS session (your current conversation), optionally filtered by status. Preferred way to check the state of proposals you are working on. Session-local: proposals from other or past sessions are not listed, and after session expiry/teardown this list is empty — those proposals still exist and remain reachable via list_proposals or an explicit proposal_id.",
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
      description: "Read the details of a specific proposal, including its sections, content, and human-involvement evaluation. This is a proposal RECORD (JSON); to read a section's text, use read_proposal_section, which answers with the raw markdown.",
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
      description: "Read a specific section as it appears inside a proposal. The response IS the section's raw markdown (heading line + body) — no JSON envelope.",
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

  // Renamed/removed wire names — a call to one returns a migration message, not
  // an unknown-tool error.
  // `commit_proposal` was renamed to `publish_proposal`.
  registry.deprecate("commit_proposal");
  // `read_doc_structure` is temporarily off the live surface; steer callers to
  // list_sections (production trial — restore registration above to re-enable).
  registry.deprecate(
    "read_doc_structure",
    'The tool "read_doc_structure" has been removed. Use list_sections instead ' +
      "(pass a document path to list that document's sections, or a folder/root " +
      "path to inventory sections across documents). Refresh your tool list " +
      "(tools/list) and re-fetch the latest skill.md / cursor-rule.md if your " +
      "client still advertises read_doc_structure.",
  );
}
