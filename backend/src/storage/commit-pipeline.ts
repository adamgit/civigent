/**
 * v3 Commit Pipeline — Involvement-Based Evaluation
 *
 * Replaces the v2 multi-stage pipeline (lock check → temporal freshness →
 * stale references → resolution evaluation → git commit) with a single
 * human-involvement evaluation pass per section.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  sectionGlobalKey,
  type Proposal,
  type ProposalHumanInvolvementEvaluation,
  type EvaluatedSection,
  type WriterIdentity,
  SectionScoreSnapshot,
} from "../types/shared.js";
import { SectionGuard } from "../domain/section-guard.js";
import { SectionRef } from "../domain/section-ref.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { proposalContentRoot } from "./proposal-repository.js";
import { getHeadSha, gitExec } from "./git-repo.js";
import { resolveHeadingPath } from "./heading-resolver.js";
import { ContentLayer } from "./content-layer.js";
import {
  transitionToCommitting,
  transitionToCommitted,
  rollbackCommittingToPending,
} from "./proposal-repository.js";

export interface EvaluationResult {
  evaluation: ProposalHumanInvolvementEvaluation;
  sections: EvaluatedSection[];
}

/**
 * Compute human involvement for each section in a proposal.
 * Delegates to SectionGuard.evaluateBatch() for all evaluation logic.
 */
export async function evaluateProposalHumanInvolvement(
  proposal: Proposal,
): Promise<EvaluationResult> {
  return SectionGuard.evaluateBatch(
    proposal.sections.map((s) => ({
      doc_path: s.doc_path,
      heading_path: s.heading_path,
      justification: s.justification,
    })),
  );
}

/**
 * Write a proposal's section content to canonical files and create a git commit.
 */
export async function commitProposalToCanonical(
  proposal: Proposal,
  scores: SectionScoreSnapshot,
): Promise<string> {
  const dataRoot = getDataRoot();

  // Transition to committing (guard state)
  await transitionToCommitting(proposal.id);

  try {
    // Copy each section's content from proposal content root to canonical
    const canonical = new ContentLayer(getContentRoot());
    const proposalContent = new ContentLayer(proposalContentRoot(proposal.id, "committing"), canonical);
    for (const section of proposal.sections) {
      const sectionRef = SectionRef.fromTarget(section);
      const content = await proposalContent.readSection(sectionRef);
      await canonical.writeSection(sectionRef, content);
    }

    // Stage and commit
    await gitExec(["add", "-A", "content/"], dataRoot);

    const sectionList = proposal.sections
      .map((s) => `  - ${sectionGlobalKey(s.doc_path, s.heading_path)}`)
      .join("\n");

    const commitMessage = `agent proposal: ${proposal.intent}\n\nSections:\n${sectionList}\n\nProposal: ${proposal.id}\nWriter: ${proposal.writer.id}`;

    await gitExec(
      [
        "-c", "user.name=Knowledge Store",
        "-c", "user.email=system@knowledge-store.local",
        "commit",
        "-m", commitMessage,
        "--allow-empty",
      ],
      dataRoot,
    );

    const headSha = await getHeadSha(dataRoot);

    // Transition to committed
    await transitionToCommitted(proposal.id, headSha, scores);

    return headSha;
  } catch (error) {
    // Rollback to pending on failure
    try {
      await rollbackCommittingToPending(proposal.id);
    } catch (rollbackError) {
      // Both commit and rollback failed — proposal stuck in committing state.
      // Surface both errors so crash recovery can detect and fix this.
      throw new AggregateError(
        [error, rollbackError],
        `Commit failed AND rollback failed for proposal ${proposal.id} — proposal stuck in committing state`,
      );
    }
    throw error;
  }
}

/**
 * Write human CRDT changes to canonical files and create a git commit.
 * Used by the auto-commit batcher and manual publish.
 */
export async function commitHumanChangesToCanonical(
  writer: WriterIdentity,
  sections: Array<{ doc_path: string; heading_path: string[]; content: string }>,
  coAuthors?: Array<{ name: string; email: string }>,
): Promise<string> {
  const dataRoot = getDataRoot();

  for (const section of sections) {
    const resolvedPath = await resolveHeadingPath(section.doc_path, section.heading_path);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, section.content, "utf8");
  }

  await gitExec(["add", "-A", "content/"], dataRoot);

  const sectionList = sections
    .map((s) => `  - ${sectionGlobalKey(s.doc_path, s.heading_path)}`)
    .join("\n");

  let commitMessage = `human edit: ${writer.displayName}\n\nSections:\n${sectionList}\n\nWriter: ${writer.id}`;

  // Append Co-authored-by trailers for compound attribution
  if (coAuthors && coAuthors.length > 0) {
    const trailers = coAuthors
      .map((a) => `Co-authored-by: ${a.name} <${a.email}>`)
      .join("\n");
    commitMessage += "\n" + trailers;
  }

  await gitExec(
    [
      "-c", `user.name=${writer.displayName}`,
      "-c", `user.email=${writer.email || "human@knowledge-store.local"}`,
      "commit",
      "-m", commitMessage,
      "--allow-empty",
    ],
    dataRoot,
  );

  return getHeadSha(dataRoot);
}
