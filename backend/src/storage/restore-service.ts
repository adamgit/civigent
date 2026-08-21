/**
 * Restore-via-proposal service.
 *
 * Reads a document's historical state from git and creates a proposal that,
 * when committed, restores the document to that historical state.
 * Conflict detection, section locks, and human-involvement scoring all apply
 * automatically because the restore goes through the normal proposal pipeline.
 */

import type { WriterIdentity, AnyProposal, ProposalSectionClaim } from "../types/shared.js";
import { CanonicalReader } from "./canonical-reader.js";
import { DocumentNotFoundError, DocumentAssemblyError } from "./content-layer.js";
import { ProposalEditor } from "./proposal-editor.js";
import { createTransientProposal, unsafeReplaceProposalManifestForRecoveryOnly, readProposal } from "./proposal-repository.js";
import { documentTargetRef } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";
import type { DocPath } from "../types/shared.js";

export class RestoreValidationError extends Error {}

export interface RestoreResult {
  proposal: AnyProposal;
  contentRoot: string;
}

/**
 * Create a proposal that restores a document to its state at a historical commit.
 *
 * Strategy: copy the exact skeleton file and section body files from the
 * target git commit byte-for-byte into the proposal overlay — no parsing,
 * no normalization, no round-tripping. A restore is a historical snapshot
 * replay, not a re-import.
 */
export async function createRestoreProposal(
  docPath: DocPath,
  targetSha: string,
  writer: WriterIdentity,
): Promise<RestoreResult> {
  // Create proposal with empty placeholder sections — updated after writing
  const { id: restoreProposalId, contentRoot } = await createTransientProposal(
    writer,
    `Restore "${docPath}" to version ${targetSha.slice(0, 8)}`,
    [],
  );

  // Replay the document's historical state into the proposal content tree
  // through the editor facade — byte-for-byte, no normalization. The editor
  // validates assembly and surfaces DocumentAssemblyError when the historical
  // commit is missing referenced body files.
  const editor = ProposalEditor.open(restoreProposalId, "pending");
  let restoredHeadingPaths: string[][];
  try {
    ({ restoredHeadingPaths } = await editor.replayDocumentFromGitCommit(docPath, targetSha));
  } catch (err) {
    if (err instanceof DocumentAssemblyError) {
      throw new RestoreValidationError(
        `Restore to ${targetSha.slice(0, 8)} failed: the historical commit is missing section body files: ${err.message}. ` +
        `This version cannot be restored because the corruption exists in git history. ` +
        `Use the diagnostics page to identify the affected sections.`,
      );
    }
    throw err;
  }

  const restoredTargets: ProposalSectionClaim[] = restoredHeadingPaths.map(hp => ({
    doc_path: docPath,
    heading_path: hp,
  }));

  // Compute sections present in canonical but absent from the restored version.
  // These are being deleted by the restore — they must appear in the proposal manifest
  // so that conflict detection, lock checks, and human-involvement scoring evaluate them.
  const canonicalReader = CanonicalReader.open();
  const deletedSections: ProposalSectionClaim[] = [];
  try {
    const canonicalSections = await canonicalReader.listEffectiveSections(docPath);
    const restoredKeys = new Set(restoredHeadingPaths.map(hp => SectionRef.headingKey(hp)));
    for (const entry of canonicalSections) {
      if (!restoredKeys.has(SectionRef.headingKey(entry.headingPath))) {
        deletedSections.push({ doc_path: docPath, heading_path: entry.headingPath });
      }
    }
  } catch (err) {
    if (!(err instanceof DocumentNotFoundError)) throw err;
    // Document doesn't exist in canonical yet — no deletions to track
  }

  // Restore legitimately owns its own manifest derivation (byte-for-byte git
  // replay + canonical-diff of deleted sections), so it uses the explicit
  // recovery escape hatch rather than the `mutateProposalContent(...)` boundary
  // (Claim 3: narrowly-justified recovery internal). It also claims a DOCUMENT
  // target for the restored document path so the restore holds a lock/audit claim
  // even when the historical version has no sections (spec 12 / Claim 10).
  await unsafeReplaceProposalManifestForRecoveryOnly(
    restoreProposalId,
    [...restoredTargets, ...deletedSections],
    undefined,
    [documentTargetRef(docPath)],
  );

  // Read fresh proposal from disk — sections are up-to-date after update
  const proposal = await readProposal(restoreProposalId);
  return { proposal, contentRoot };
}
