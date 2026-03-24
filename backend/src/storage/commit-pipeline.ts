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
import { CanonicalStore } from "./canonical-store.js";

export interface EvaluationResult {
  evaluation: ProposalHumanInvolvementEvaluation;
  sections: EvaluatedSection[];
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
export async function commitProposalToCanonical(
  proposalId: ProposalId,
  scores: SectionScoreSnapshot,
  diagnostics?: string[],
): Promise<string> {
  const proposal = await readProposal(proposalId);
  const dataRoot = getDataRoot();
  const overlayRoot = proposalContentRoot(proposal.id, "committing");

  // Transition to committing (guard state)
  await transitionToCommitting(proposal.id);

  try {
    const store = new CanonicalStore(getContentRoot(), dataRoot);

    const sectionList = proposal.sections
      .map((s) => `  - ${sectionGlobalKey(s.doc_path, s.heading_path)}`)
      .join("\n");
    const commitMessage = `agent proposal: ${proposal.intent}\n\nSections:\n${sectionList}\n\nProposal: ${proposal.id}\nWriter: ${proposal.writer.id}`;
    const author = {
      name: proposal.writer.displayName,
      email: `${proposal.writer.id}@knowledge-store.local`,
    };

    const headSha = await store.absorb(overlayRoot, commitMessage, author, { diagnostics });

    // Transition to committed
    await transitionToCommitted(proposal.id, headSha, scores);

    if (isSnapshotGenerationEnabled()) {
      const docPaths = new Set(proposal.sections.map((s) => s.doc_path));
      scheduleSnapshotRegeneration(Array.from(docPaths));
    }

    return headSha;
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

/**
 * Write human CRDT session changes to canonical and create a git commit.
 * sessionDocsContentRoot is the sessions/docs/content/ directory —
 * a valid staging root in skeleton+section-file layout.
 */
export async function commitHumanChangesToCanonical(
  writer: WriterIdentity,
  sessionDocsContentRoot: string,
  coAuthors?: Array<{ name: string; email: string }>,
): Promise<string> {
  let commitMessage = `human edit: ${writer.displayName}\n\nWriter: ${writer.id}`;
  if (coAuthors && coAuthors.length > 0) {
    const trailers = coAuthors.map((a) => `Co-authored-by: ${a.name} <${a.email}>`).join("\n");
    commitMessage += "\n" + trailers;
  }
  const author = { name: writer.displayName, email: writer.email || "human@knowledge-store.local" };
  const store = new CanonicalStore(getContentRoot(), getDataRoot());
  return store.absorb(sessionDocsContentRoot, commitMessage, author);
}
