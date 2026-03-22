/**
 * v3 Commit Pipeline — Involvement-Based Evaluation
 *
 * Replaces the v2 multi-stage pipeline (lock check → temporal freshness →
 * stale references → resolution evaluation → git commit) with a single
 * human-involvement evaluation pass per section.
 */

import { writeFile, mkdir, readdir, copyFile, stat } from "node:fs/promises";
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
import { getContentRoot, getDataRoot } from "./data-root.js";
import { proposalContentRoot, readProposal } from "./proposal-repository.js";
import { getHeadSha, gitExec } from "./git-repo.js";
import { resolveHeadingPath } from "./heading-resolver.js";
import { ContentLayer } from "./content-layer.js";
import {
  transitionToCommitting,
  transitionToCommitted,
  rollbackCommittingToPending,
} from "./proposal-repository.js";
import { isSnapshotGenerationEnabled, scheduleSnapshotRegeneration } from "./snapshot.js";

/**
 * Recursively copy all files from src to dest, preserving subdirectory structure.
 */
async function copyDirectoryContents(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyDirectoryContents(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

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

    const docPaths = new Set(proposal.sections.map((s) => s.doc_path));

    for (const docPath of docPaths) {
      const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");

      // 1. If overlay has a skeleton → promoteOverlay (copies skeleton to canonical,
      //    deletes orphaned body files from old skeleton)
      const proposalOverlay = new ContentLayer(overlayRoot, new ContentLayer(canonicalRoot));
      const skeleton = await proposalOverlay.readSkeleton(docPath);
      if (skeleton.overlayPersisted) {
        await skeleton.promoteOverlay();
      }

      // 2. If overlay has a .sections/ directory → copy each file to canonical .sections/
      const overlaySectionsDir = path.resolve(overlayRoot, ...normalized.split("/")) + ".sections";
      try {
        const dirStat = await stat(overlaySectionsDir);
        if (dirStat.isDirectory()) {
          const canonicalSectionsDir = path.resolve(canonicalRoot, ...normalized.split("/")) + ".sections";
          await mkdir(canonicalSectionsDir, { recursive: true });
          await copyDirectoryContents(overlaySectionsDir, canonicalSectionsDir);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // No .sections/ in overlay — no body files to copy (e.g. tombstone-only)
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
    // Rollback: move proposal back to pending, then restore canonical to last committed state
    await rollbackCommittingToPending(proposal.id);
    await gitExec(["checkout", "--", "content/"], dataRoot).catch(() => {});
    await gitExec(["clean", "-fd", "content/"], dataRoot).catch(() => {});
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
