/**
 * v3 Commit Pipeline — Involvement-Based Evaluation
 *
 * Replaces the v2 multi-stage pipeline (lock check → temporal freshness →
 * stale references → resolution evaluation → git commit) with a single
 * human-involvement evaluation pass per section.
 */

import {
  sectionGlobalKey,
  proposalTargetLabel,
  type ProposalId,
  type HumanInvolvementPolicyResult,
  type HumanInvolvementCommittedProposalMetadata,
  type AnyProposal,
} from "../types/shared.js";
import { AgentWritePolicy } from "../domain/agent-write-policy.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { normalizeDocPath } from "./path-utils.js";
import { readProposal } from "./proposal-repository.js";
import {
  transitionToCommitting,
  transitionToCommitted,
  rollbackCommittingProposal,
  type CommittingRollbackOwnerKind,
  InvalidProposalStateError,
} from "./proposal-repository.js";
import { ProposalReader } from "./proposal-reader.js";
import { isSnapshotGenerationEnabled, scheduleSnapshotRegeneration } from "./snapshot.js";
import { CanonicalStore, type AbsorbResult } from "./canonical-store.js";

// ─────────────────────────────────────────────────────────────────

export interface CommitProposalToCanonicalOptions {
  restoreTargetSha?: string;
  commitMessageOverride?: string;
  authorOverride?: { name: string; email: string };
  /**
   * Caller context for runtime publish-failure rollback of the transient
   * `committing` guard state (spec 02 › Why `committing`). Agent proposals roll
   * back to `draft`; human-explicit / CRDTProposalGenerator-`inprogress`
   * proposals return to `inprogress` (the DocSession keeps it as its current
   * proposal). Defaults to `"agent"` to preserve the historical behaviour of the
   * many agent/transient callers (routes, MCP, import, restore).
   *
   * NOTE: this does NOT apply to startup recovery of an already-`committing`
   * proposal — that path (`publishCommittingProposalToCanonical`, consumed by
   * Area E) never rolls back; it finishes `committing` or fails-with-report.
   */
  ownerKind?: CommittingRollbackOwnerKind;
  /**
   * Synthesized audit-log description headline (spec 10 §Commit-description
   * synthesis). When present it REPLACES the default `agent proposal: <intent>`
   * headline while KEEPING the Sections/Targets blocks and the
   * `Proposal:`/`Writer:`/`Writer-Type:` trailers (attribution must survive).
   * The CRDTProposalGenerator publish path supplies this, synthesized from the
   * proposal's final changed section-set; other callers omit it (unchanged
   * behaviour). Ignored when `commitMessageOverride` is set (that wins outright).
   */
  descriptionHeadline?: string;
}

/**
 * Agent commit gate. Evaluates whether an agent proposal may publish under the
 * single selected Agent Write Policy.
 *
 * Callers branch on `result.canWrite` (top-level and per-target) and render the
 * policy's prose `message`s — NOT bare reason codes. Human / human-authoritative
 * commits must NOT call this (spec 12: "Human proposal publication does not call
 * Agent Write Policy").
 *
 * This thin wrapper exists so the many current agent call sites have a stable
 * entry point to migrate onto; it simply delegates to the selected policy.
 */
export async function evaluateAgentWritePolicy(
  proposalId: ProposalId,
): Promise<HumanInvolvementPolicyResult> {
  return AgentWritePolicy.evaluateProposal(proposalId);
}

/**
 * Build the canonical publish commit message and author for a proposal.
 *
 * Salvaged from the deleted `auto-commit.ts` co-author/trailer assembly so the
 * publish path keeps emitting `Proposal:` / `Writer:` / `Writer-Type:`
 * (and optional `Restore-Target:` / `Co-authored-by:`) trailers. Co-author
 * trailers are appended for the human/multi-writer publish path; agent
 * publication carries the standard single-writer trailers.
 */
function buildPublishCommitMessage(
  proposal: AnyProposal,
  options: CommitProposalToCanonicalOptions,
): { commitMessage: string; author: { name: string; email: string } } {
  const sectionList = proposal.sections.length > 0
    ? proposal.sections
        .map((s) => `  - ${sectionGlobalKey(s.doc_path, s.heading_path)}`)
        .join("\n")
    : "  (none — document-level operation)";
  // Authoritative committed claim set (spec 12 / Claim 10): list every target,
  // including document targets that have no section, so a live-empty document
  // operation is still named in the audit trail. The decoder now always
  // populates `targets` (deriving from `sections` for legacy missing-targets
  // files and tagging them `degraded`), so no fallback is needed here.
  const auditTargets = proposal.targets;
  const targetList = auditTargets.length > 0
    ? auditTargets.map((t) => `  - ${proposalTargetLabel(t)}`).join("\n")
    : "  (none)";
  const trailers = [
    `Proposal: ${proposal.id}`,
    `Writer: ${proposal.writer.id}`,
    `Writer-Type: ${proposal.writer.type}`,
  ];
  if (options.restoreTargetSha) {
    trailers.push(`Restore-Target: ${options.restoreTargetSha}`);
  }
  const headline = options.descriptionHeadline?.trim()
    ? options.descriptionHeadline.trim()
    : `agent proposal: ${proposal.intent}`;
  const commitMessage = options.commitMessageOverride
    ?? `${headline}\n\nSections:\n${sectionList}\n\nTargets:\n${targetList}\n\n${trailers.join("\n")}`;
  const author = options.authorOverride ?? {
    name: proposal.writer.displayName,
    email: `${proposal.writer.id}@knowledge-store.local`,
  };
  return { commitMessage, author };
}

/**
 * Section-receipt closure for absorb/cleanup reporting, derived from the
 * proposal's targeted sections. Salvaged section-receipt utility from the
 * deleted `auto-commit.ts`; mirrors `SectionRefReceipt` so `absorbedSectionRefs`
 * / `changedSections` reporting survives.
 */
function proposalSectionRefs(proposal: AnyProposal): Array<{ docPath: string; headingPath: string[] }> {
  return proposal.sections.map((section) => ({
    docPath: section.doc_path,
    headingPath: [...section.heading_path],
  }));
}

/**
 * Core publication step for a proposal that is ALREADY in `committing`.
 *
 * Reads section content from `proposalContentRoot(id, "committing")` (via the
 * `ProposalReader` facade), absorbs it into canonical as a single atomic git
 * commit, then transitions the proposal to `committed`. This is the shared body
 * used by both the standard publish flow (after `transitionToCommitting`) and
 * the Area E startup-recovery entrypoint. It performs NO state rollback on
 * failure — the caller owns recovery (runtime rollback vs recovery
 * fail-with-report) — but `absorbChangedSections` still rolls back canonical.
 */
async function absorbCommittingProposalToCanonical(
  proposalId: ProposalId,
  committedMetadata: HumanInvolvementCommittedProposalMetadata,
  diagnostics: string[] | undefined,
  options: CommitProposalToCanonicalOptions,
  // Only the crash-recovery re-run entrypoint sets this: a re-run of an
  // already-landed commit legitimately produces an empty absorb (idempotency).
  // Normal publishes leave it false and FAIL on an empty absorb.
  allowEmptyCommit = false,
): Promise<AbsorbResult> {
  const proposal = await readProposal(proposalId);
  const dataRoot = getDataRoot();
  // Resolve the proposal content root for publication input through the
  // proposal facade rather than reaching for `proposalContentRoot` directly.
  const overlayRoot = ProposalReader.open(proposal.id, "committing").proposalContentRoot;

  const store = new CanonicalStore(getContentRoot(), dataRoot);
  const { commitMessage, author } = buildPublishCommitMessage(proposal, options);

  // Manifest-overlay (Step 5d): ONLY whole-document ops (restore/import, document
  // delete/rename) claim DOCUMENT targets and take the wholesale replacement path,
  // not the section-scoped merge. Pass their paths so absorb gates them out of the
  // merge. EVERY other proposal — including a DocSession live publish (U4) — passes
  // none → manifest-scoped merge (current canonical overlaid by the manifest).
  const documentTargetPaths = proposal.targets
    .filter((t): t is { kind: "document"; doc_path: string } => t.kind === "document")
    .map((t) => t.doc_path);
  const wholesaleDocPaths = [...new Set(documentTargetPaths)];

  // Identity-based delete detection (D5): hand the absorb merge the canonical
  // section-file ids this proposal deleted, grouped by doc, so the new canonical
  // skeleton drops them by stable id (a delete survives ancestor rename/move).
  const deletedSectionFilesByDoc = new Map<string, Set<string>>();
  for (const ref of proposal.deleted_section_files ?? []) {
    const dp = normalizeDocPath(ref.doc_path);
    if (!deletedSectionFilesByDoc.has(dp)) deletedSectionFilesByDoc.set(dp, new Set<string>());
    deletedSectionFilesByDoc.get(dp)!.add(ref.section_file);
  }

  const absorbResult = await store.absorbChangedSections(overlayRoot, commitMessage, author, {
    diagnostics,
    absorbedSectionRefs: proposalSectionRefs(proposal),
    documentPathsToRewrite: wholesaleDocPaths.length > 0 ? wholesaleDocPaths : undefined,
    deletedSectionFilesByDoc,
    // Empty-absorb permission is scoped to explicit classified recovery/idempotency
    // paths ONLY (`allowEmptyCommit`, set solely by
    // `publishCommittingProposalToCanonical`). A normal agent / human / transient /
    // DocSession publish must FAIL if it would rewrite no documents and absorb no
    // sections — being non-DocSession is NOT a licence to write an empty canonical
    // commit. Legitimate document-level operations (create/delete/rename/restore/
    // import) prove themselves via their DOCUMENT targets: those populate
    // `documentPathsToRewrite`, so `rewrittenDocumentPaths` is non-empty and the
    // absorb passes the empty-commit guard without any empty allowance.
    allowEmpty: allowEmptyCommit,
  });
  // Transition to committed
  await transitionToCommitted(proposal.id, absorbResult.commitSha, committedMetadata);

  if (isSnapshotGenerationEnabled()) {
    const docPaths = new Set(proposal.sections.map((s) => s.doc_path));
    scheduleSnapshotRegeneration(Array.from(docPaths));
  }

  return absorbResult;
}

/**
 * PUBLICATION RESULT TYPE (Area C decision, for Areas I/J).
 *
 * The surviving publication API returns `AbsorbResult` (from `canonical-store`)
 * — NOT a resurrected `AutoCommitResult` / `PreemptiveCommitResult`. The
 * canonical commit receipt (`commitSha`, `rewrittenDocumentPaths`,
 * `absorbedSectionRefs`, `changedSections`) is the single source of truth for
 * what landed; REST routes (Area I) and MCP filesystem auto-commit (Area J)
 * should consume `AbsorbResult` (or `publishProposalToCanonical`'s `commitSha`
 * string form) and shape any wire DTO at their own boundary, rather than
 * re-introducing a storage-layer auto-commit result shape. Owner location: this
 * module re-exports `AbsorbResult` via the function return types; the type
 * itself stays defined in `canonical-store.ts`.
 */
export type { AbsorbResult } from "./canonical-store.js";

/**
 * Publish a proposal to canonical: transition `→ committing`, write its section
 * content to canonical files, and create a git commit. Reads the proposal from
 * disk to guarantee fresh data — no stale-object bugs.
 *
 * This is the single application-level proposal→canonical publication routine,
 * shared (as separate callers, not shared sidecar logic) by manual/explicit
 * proposal commit, agent commit, and CRDTProposalGenerator publish
 * (spec 11 › Relationship to CRDTProposalGenerator).
 *
 * On runtime failure the transient `committing` guard state is rolled back per
 * caller context (`options.ownerKind`): agent → `draft`, human/DocSession →
 * `inprogress` (spec 02 › Why `committing`). Startup recovery of an
 * already-`committing` proposal does NOT use this entry point — see
 * `publishCommittingProposalToCanonical`.
 */
export async function publishProposalToCanonicalDetailed(
  proposalId: ProposalId,
  committedMetadata: HumanInvolvementCommittedProposalMetadata,
  diagnostics?: string[],
  options: CommitProposalToCanonicalOptions = {},
): Promise<AbsorbResult> {
  // Transition to committing (guard state)
  await transitionToCommitting(proposalId);

  try {
    return await absorbCommittingProposalToCanonical(
      proposalId,
      committedMetadata,
      diagnostics,
      options,
    );
  } catch (error) {
    // absorb() already rolled back canonical. Roll back FSM state if the
    // proposal reached committing/, using caller context to pick the target.
    try {
      await rollbackCommittingProposal(proposalId, options.ownerKind ?? "agent");
    } catch (fsmErr) {
      // transitionToCommitting may have thrown before completing — proposal not
      // in committing, nothing to roll back.
      if (!(fsmErr instanceof InvalidProposalStateError)) throw fsmErr;
    }
    throw error;
  }
}

export async function publishProposalToCanonical(
  proposalId: ProposalId,
  committedMetadata: HumanInvolvementCommittedProposalMetadata,
  diagnostics?: string[],
  options: CommitProposalToCanonicalOptions = {},
): Promise<string> {
  const absorbResult = await publishProposalToCanonicalDetailed(
    proposalId,
    committedMetadata,
    diagnostics,
    options,
  );
  return absorbResult.commitSha;
}

/**
 * Re-runnable startup-recovery entrypoint (consumed by Area E crash recovery):
 * publish an ALREADY-`committing` proposal WITHOUT re-running
 * `transitionToCommitting`. Reads section content from
 * `proposalContentRoot(id, "committing")`, absorbs into canonical, and
 * transitions to `committed`.
 *
 * Idempotency / partial-landing: `absorbChangedSections` git-commits with
 * `--allow-empty`, so a re-run after an already-landed canonical delta is a
 * no-op delta that still produces a valid `commitSha` and lets the FSM advance
 * to `committed` (finalize-if-landed). A re-run before the delta landed simply
 * re-absorbs (rerun-absorb). On failure it does NOT roll back the FSM —
 * recovery owns its own fail-with-report (spec 02 › Why `committing`;
 * spec 05 › Proposal Publication). The proposal MUST already be in `committing`;
 * `transitionToCommitted` throws `InvalidProposalStateError` otherwise.
 */
export async function publishCommittingProposalToCanonical(
  proposalId: ProposalId,
  committedMetadata: HumanInvolvementCommittedProposalMetadata = {},
  diagnostics?: string[],
  options: CommitProposalToCanonicalOptions = {},
): Promise<AbsorbResult> {
  const proposal = await readProposal(proposalId);
  if (proposal.status !== "committing") {
    throw new InvalidProposalStateError(
      `Cannot recover-publish proposal ${proposalId}: status is ${proposal.status}, expected committing.`,
    );
  }
  // Recovery/idempotency path: a re-run of an already-landed commit legitimately
  // absorbs nothing, so an empty commit is permitted here (and only here).
  return absorbCommittingProposalToCanonical(
    proposalId,
    committedMetadata,
    diagnostics,
    options,
    true,
  );
}

// ─── Deprecated aliases ─────────────────────────────────────────────
//
// The pre-narrowing names are retained so the many callers in
// `api/routes/index.ts`, `mcp/tools/{collaboration,filesystem}.ts`,
// `content-import.ts`, and the CRDTProposalGenerator keep compiling until
// Areas I/J/K port them onto the publication-intent names. These are exact
// re-exports; do not add behaviour here.

/** @deprecated Use `publishProposalToCanonicalDetailed`. */
export const commitProposalToCanonicalDetailed = publishProposalToCanonicalDetailed;

/** @deprecated Use `publishProposalToCanonical`. */
export const commitProposalToCanonical = publishProposalToCanonical;
