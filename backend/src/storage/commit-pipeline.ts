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
  type ProposalId,
  type ProposalHumanInvolvementEvaluation,
  type EvaluatedSection,
  type WriterIdentity,
  SectionScoreSnapshot,
} from "../types/shared.js";
import { SectionGuard } from "../domain/section-guard.js";
import { SectionRef } from "../domain/section-ref.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { proposalContentRoot, readProposal } from "./proposal-repository.js";
import { getHeadSha, gitExec } from "./git-repo.js";
import { resolveHeadingPath } from "./heading-resolver.js";
import { ContentLayer, SectionNotFoundError } from "./content-layer.js";
import { DocumentSkeleton } from "./document-skeleton.js";
import {
  transitionToCommitting,
  transitionToCommitted,
  rollbackCommittingToPending,
} from "./proposal-repository.js";
import { isSnapshotGenerationEnabled, scheduleSnapshotRegeneration } from "./snapshot.js";

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
): Promise<string> {
  const proposal = await readProposal(proposalId);
  const dataRoot = getDataRoot();

  // Transition to committing (guard state)
  await transitionToCommitting(proposal.id);

  try {
    const canonicalRoot = getContentRoot();
    const overlayRoot = proposalContentRoot(proposal.id, "committing");

    // Promote structural changes (skeleton files) from proposal overlay to canonical.
    // For each unique doc path in the proposal, check if the overlay contains a
    // skeleton file. If so, use promoteOverlay() to merge skeleton changes into
    // canonical (handles orphan cleanup automatically).
    const docPaths = new Set(proposal.sections.map((s) => s.doc_path));
    const promotedDocs = new Set<string>();
    for (const docPath of docPaths) {
      const proposalOverlay = new ContentLayer(overlayRoot, new ContentLayer(canonicalRoot));
      const skeleton = await proposalOverlay.readSkeleton(docPath);
      if (skeleton.overlayPersisted) {
        await skeleton.promoteOverlay();
        promotedDocs.add(docPath);
      }
    }

    // Copy section body files from proposal overlay to canonical.
    // For promoted docs: walk the promoted skeleton to discover ALL body files (by absolute
    // path, not by heading path from proposal.sections — the skeleton is authoritative).
    // For non-promoted docs: copy by heading path from proposal.sections.
    const canonical = new ContentLayer(canonicalRoot);
    const proposalContent = new ContentLayer(overlayRoot, canonical);
    const copyTasks: Promise<void>[] = [];

    for (const docPath of promotedDocs) {
      const promotedSkeleton = await DocumentSkeleton.fromDisk(docPath, canonicalRoot, canonicalRoot);
      const overlayContentLayer = new ContentLayer(overlayRoot);

      // Copy each body file that exists in the proposal overlay
      promotedSkeleton.forEachSection((_heading, _level, _sectionFile, headingPath) => {
        const sectionRef = new SectionRef(docPath, [...headingPath]);
        copyTasks.push(
          overlayContentLayer.readSection(sectionRef)
            .then(async (content) => {
              await canonical.writeSection(sectionRef, content);
            })
            .catch((err) => {
              // Body file might not exist in overlay (section unchanged from canonical) — skip
              if (err instanceof SectionNotFoundError) return;
              throw err;
            }),
        );
      });
    }

    // Non-promoted docs: copy by heading path from proposal.sections
    for (const section of proposal.sections) {
      if (promotedDocs.has(section.doc_path)) continue; // already handled above
      const sectionRef = SectionRef.fromTarget(section);
      copyTasks.push(
        proposalContent.readSection(sectionRef)
          .then(async (content) => {
            await canonical.writeSection(sectionRef, content);
          })
          .catch((err) => {
            if (err instanceof SectionNotFoundError) return;
            throw err;
          }),
      );
    }

    await Promise.all(copyTasks);

    // Validate: every skeleton entry must have a body file in canonical.
    // This is the last gate before git add bakes corruption into history.
    const { access: accessFile } = await import("node:fs/promises");
    for (const docPath of promotedDocs) {
      const finalSkeleton = await DocumentSkeleton.fromDisk(docPath, canonicalRoot, canonicalRoot);
      const missingFiles: string[] = [];
      finalSkeleton.forEachSection((_heading, _level, _sectionFile, _headingPath, absolutePath) => {
        // Collect for async check below (forEachSection is sync)
        missingFiles.push(absolutePath);
      });
      for (const absPath of missingFiles) {
        try {
          await accessFile(absPath);
        } catch {
          throw new Error(
            `Commit validation failed for "${docPath}": skeleton references body file "${path.basename(absPath)}" but the file does not exist on disk. ` +
            `This indicates a bug in the proposal pipeline — the skeleton was promoted but the body file was not copied. ` +
            `Proposal: ${proposal.id}`,
          );
        }
      }
    }

    // Stage and commit
    await gitExec(["add", "-A", "content/"], dataRoot);

    const sectionList = proposal.sections
      .map((s) => `  - ${sectionGlobalKey(s.doc_path, s.heading_path)}`)
      .join("\n");

    const commitMessage = `agent proposal: ${proposal.intent}\n\nSections:\n${sectionList}\n\nProposal: ${proposal.id}\nWriter: ${proposal.writer.id}`;

    await gitExec(
      [
        "-c", `user.name=${proposal.writer.displayName}`,
        "-c", `user.email=${proposal.writer.id}@knowledge-store.local`,
        "commit",
        "-m", commitMessage,
        "--allow-empty",
      ],
      dataRoot,
    );

    const headSha = await getHeadSha(dataRoot);

    // Transition to committed
    await transitionToCommitted(proposal.id, headSha, scores);

    if (isSnapshotGenerationEnabled()) {
      scheduleSnapshotRegeneration(Array.from(docPaths));
    }

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

  if (isSnapshotGenerationEnabled()) {
    scheduleSnapshotRegeneration(sections.map((s) => s.doc_path));
  }

  return getHeadSha(dataRoot);
}
