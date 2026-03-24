/**
 * Restore-via-proposal service.
 *
 * Reads a document's historical state from git and creates a proposal that,
 * when committed, restores the document to that historical state.
 * Conflict detection, section locks, and human-involvement scoring all apply
 * automatically because the restore goes through the normal proposal pipeline.
 */

import type { WriterIdentity, AnyProposal, ProposalSection } from "../types/shared.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { assembleDocumentAtCommit } from "./git-repo.js";
import { ContentLayer, DocumentNotFoundError } from "./content-layer.js";
import { createTransientProposal, updateProposalSections, readProposal } from "./proposal-repository.js";
import { SectionRef } from "../domain/section-ref.js";

export interface RestoreResult {
  proposal: AnyProposal;
  contentRoot: string;
}

/**
 * Create a proposal that restores a document to its state at a historical commit.
 *
 * Strategy:
 * 1. Create a proposal to get a content overlay directory
 * 2. Assemble the historical document in-memory from git (no disk writes)
 * 3. Write the assembled content into the overlay via importMarkdownDocument
 *    (with the canonical root as fallback, for correct file-ID matching)
 * 4. Update proposal sections to the restored structure only
 */
export async function createRestoreProposal(
  docPath: string,
  targetSha: string,
  writer: WriterIdentity,
): Promise<RestoreResult> {
  const dataRoot = getDataRoot();
  const canonicalRoot = getContentRoot();

  // Create proposal with empty placeholder sections — updated after writing
  const { id: restoreProposalId, contentRoot } = await createTransientProposal(
    writer,
    `Restore "${docPath}" to version ${targetSha.slice(0, 8)}`,
    [],
  );

  // Assemble historical document from git entirely in-memory (no disk writes)
  const { content: assembledHistorical } = await assembleDocumentAtCommit(dataRoot, targetSha, docPath);

  // Write through importMarkdownDocument with canonical fallback for correct file-ID matching
  const normalizedLayer = new ContentLayer(contentRoot, new ContentLayer(canonicalRoot));
  const restoredTargets = await normalizedLayer.importMarkdownDocument(docPath, assembledHistorical);

  // Compute sections present in canonical but absent from the restored version.
  // These are being deleted by the restore — they must appear in the proposal manifest
  // so that conflict detection, lock checks, and human-involvement scoring evaluate them.
  const canonicalLayer = new ContentLayer(canonicalRoot);
  const deletedSections: ProposalSection[] = [];
  try {
    const canonicalSections = await canonicalLayer.getSectionList(docPath);
    const restoredKeys = new Set(restoredTargets.map(t => SectionRef.headingKey(t.heading_path)));
    for (const entry of canonicalSections) {
      if (!restoredKeys.has(SectionRef.headingKey(entry.headingPath))) {
        deletedSections.push({ doc_path: docPath, heading_path: entry.headingPath });
      }
    }
  } catch (err) {
    if (!(err instanceof DocumentNotFoundError)) throw err;
    // Document doesn't exist in canonical yet — no deletions to track
  }

  await updateProposalSections(restoreProposalId, [...restoredTargets, ...deletedSections]);

  // Read fresh proposal from disk — sections are up-to-date after update
  const proposal = await readProposal(restoreProposalId);
  return { proposal, contentRoot };
}
