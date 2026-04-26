/**
 * v3 Commit Pipeline — Involvement-Based Evaluation
 *
 * Replaces the v2 multi-stage pipeline (lock check → temporal freshness →
 * stale references → resolution evaluation → git commit) with a single
 * human-involvement evaluation pass per section.
 */

import {
  sectionGlobalKey,
  type ProposalId,
  type ProposalHumanInvolvementEvaluation,
  type EvaluatedSection,
  type WriterIdentity,
  SectionScoreSnapshot,
} from "../types/shared.js";
import { SectionGuard } from "../domain/section-guard.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { proposalContentRoot, readProposal } from "./proposal-repository.js";
import {
  transitionToCommitting,
  transitionToCommitted,
  rollbackCommittingToDraft,
  InvalidProposalStateError,
} from "./proposal-repository.js";
import { isSnapshotGenerationEnabled, scheduleSnapshotRegeneration } from "./snapshot.js";
import { CanonicalStore, type AbsorbResult } from "./canonical-store.js";

// ─────────────────────────────────────────────────────────────────

export interface EvaluationResult {
  evaluation: ProposalHumanInvolvementEvaluation;
  sections: EvaluatedSection[];
}

export interface CommitProposalToCanonicalOptions {
  restoreTargetSha?: string;
  commitMessageOverride?: string;
  authorOverride?: { name: string; email: string };
}

/**
 * Compute human involvement for each section in a proposal.
 * Reads the proposal from disk to guarantee fresh data.
 * Delegates to SectionGuard.evaluateBatch() for all evaluation logic.
 */
export async function evaluateProposalHumanInvolvement(
  proposalId: ProposalId,
): Promise<EvaluationResult> {
  const proposal = await readProposal(proposalId);
  return SectionGuard.evaluateBatch(
    proposal.sections.map((s) => ({
      doc_path: s.doc_path,
      heading_path: s.heading_path,
      justification: s.justification,
    })),
    proposal.id,
  );
}

/**
 * Write a proposal's section content to canonical files and create a git commit.
 * Reads the proposal from disk to guarantee fresh data — no stale-object bugs.
 */
export async function commitProposalToCanonicalDetailed(
  proposalId: ProposalId,
  scores: SectionScoreSnapshot,
  diagnostics?: string[],
  options: CommitProposalToCanonicalOptions = {},
): Promise<AbsorbResult> {
  const proposal = await readProposal(proposalId);
  const dataRoot = getDataRoot();
  const overlayRoot = proposalContentRoot(proposal.id, "committing");

  // Transition to committing (guard state)
  await transitionToCommitting(proposal.id);

  try {
    const store = new CanonicalStore(getContentRoot(), dataRoot);

    const sectionList = proposal.sections.length > 0
      ? proposal.sections
          .map((s) => `  - ${sectionGlobalKey(s.doc_path, s.heading_path)}`)
          .join("\n")
      : "  (none — document-level operation)";
    const trailers = [
      `Proposal: ${proposal.id}`,
      `Writer: ${proposal.writer.id}`,
      `Writer-Type: ${proposal.writer.type}`,
    ];
    if (options.restoreTargetSha) {
      trailers.push(`Restore-Target: ${options.restoreTargetSha}`);
    }
    const commitMessage = options.commitMessageOverride
      ?? `agent proposal: ${proposal.intent}\n\nSections:\n${sectionList}\n\n${trailers.join("\n")}`;
    const author = options.authorOverride ?? {
      name: proposal.writer.displayName,
      email: `${proposal.writer.id}@knowledge-store.local`,
    };

    const absorbResult = await store.absorbChangedSections(overlayRoot, commitMessage, author, {
      diagnostics,
      absorbedSectionRefs: proposal.sections.map((section) => ({
        docPath: section.doc_path,
        headingPath: [...section.heading_path],
      })),
    });
    // Transition to committed
    await transitionToCommitted(proposal.id, absorbResult.commitSha, scores);

    if (isSnapshotGenerationEnabled()) {
      const docPaths = new Set(proposal.sections.map((s) => s.doc_path));
      scheduleSnapshotRegeneration(Array.from(docPaths));
    }

    return absorbResult;
  } catch (error) {
    // absorb() already rolled back canonical. Roll back FSM state if proposal reached committing/.
    try {
      await rollbackCommittingToDraft(proposal.id);
    } catch (fsmErr) {
      // transitionToCommitting may have thrown before completing — proposal still in draft, nothing to roll back
      if (!(fsmErr instanceof InvalidProposalStateError)) throw fsmErr;
    }
    throw error;
  }
}

export async function commitProposalToCanonical(
  proposalId: ProposalId,
  scores: SectionScoreSnapshot,
  diagnostics?: string[],
  options: CommitProposalToCanonicalOptions = {},
): Promise<string> {
  const absorbResult = await commitProposalToCanonicalDetailed(
    proposalId,
    scores,
    diagnostics,
    options,
  );
  return absorbResult.commitSha;
}

/**
 * Write human CRDT session changes to canonical and create a git commit.
 * sessionSectionsContentRoot is the sessions/sections/content/ directory —
 * a valid staging root in skeleton+section-file layout.
 */
export async function commitHumanChangesToCanonical(
  writer: WriterIdentity,
  sessionSectionsContentRoot: string,
  coAuthors?: Array<{ name: string; email: string }>,
): Promise<string> {
  let commitMessage = `human edit: ${writer.displayName}\n\nWriter: ${writer.id}\nWriter-Type: ${writer.type}`;
  if (coAuthors && coAuthors.length > 0) {
    const trailers = coAuthors.map((a) => `Co-authored-by: ${a.name} <${a.email}>`).join("\n");
    commitMessage += "\n" + trailers;
  }
  const author = { name: writer.displayName, email: writer.email || "human@knowledge-store.local" };
  const store = new CanonicalStore(getContentRoot(), getDataRoot());
  const { commitSha } = await store.absorbChangedSections(sessionSectionsContentRoot, commitMessage, author);
  return commitSha;
}
