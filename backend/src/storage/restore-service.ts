/**
 * Restore-via-proposal service.
 *
 * Reads a document's historical state from git and creates a proposal that,
 * when committed, restores the document to that historical state.
 * Conflict detection, section locks, and human-involvement scoring all apply
 * automatically because the restore goes through the normal proposal pipeline.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { WriterIdentity, AnyProposal, ProposalSection } from "../types/shared.js";
import { getContentRoot, getDataRoot, getContentGitPrefix } from "./data-root.js";
import { gitShowFile, extractHistoricalTree } from "./git-repo.js";
import { ContentLayer, DocumentNotFoundError } from "./content-layer.js";
import { resolveSkeletonPath } from "./document-skeleton.js";
import { createTransientProposal, updateProposalSections, readProposal } from "./proposal-repository.js";
import { SectionRef } from "../domain/section-ref.js";

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
  docPath: string,
  targetSha: string,
  writer: WriterIdentity,
): Promise<RestoreResult> {
  const dataRoot = getDataRoot();
  const canonicalRoot = getContentRoot();
  const gitPrefix = getContentGitPrefix();

  // Create proposal with empty placeholder sections — updated after writing
  const { id: restoreProposalId, contentRoot } = await createTransientProposal(
    writer,
    `Restore "${docPath}" to version ${targetSha.slice(0, 8)}`,
    [],
  );

  // Compute git-relative paths for skeleton and sections directory
  const normalizedDocPath = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const skeletonGitPath = `${gitPrefix}/${normalizedDocPath}`;
  const sectionsDirGitPrefix = `${gitPrefix}/${normalizedDocPath}.sections/`;

  // Copy skeleton file byte-for-byte from git
  const skeletonContent = await gitShowFile(dataRoot, targetSha, skeletonGitPath);
  const overlaySkeletonPath = resolveSkeletonPath(docPath, contentRoot);
  await mkdir(path.dirname(overlaySkeletonPath), { recursive: true });
  await writeFile(overlaySkeletonPath, skeletonContent, "utf8");

  // Copy all section body files byte-for-byte from git
  const overlaySectionsDir = overlaySkeletonPath + ".sections";
  await extractHistoricalTree(dataRoot, targetSha, sectionsDirGitPrefix, overlaySectionsDir);

  // Read the restored skeleton to get heading paths for proposal sections
  const overlayLayer = new ContentLayer(contentRoot);
  const restoredHeadingPaths = await overlayLayer.listHeadingPaths(docPath);
  const restoredTargets: ProposalSection[] = restoredHeadingPaths.map(hp => ({
    doc_path: docPath,
    heading_path: hp,
  }));

  // Compute sections present in canonical but absent from the restored version.
  // These are being deleted by the restore — they must appear in the proposal manifest
  // so that conflict detection, lock checks, and human-involvement scoring evaluate them.
  const canonicalLayer = new ContentLayer(canonicalRoot);
  const deletedSections: ProposalSection[] = [];
  try {
    const canonicalSections = await canonicalLayer.getSectionList(docPath);
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

  await updateProposalSections(restoreProposalId, [...restoredTargets, ...deletedSections]);

  // Read fresh proposal from disk — sections are up-to-date after update
  const proposal = await readProposal(restoreProposalId);
  return { proposal, contentRoot };
}
