/**
 * Restore-via-proposal service.
 *
 * Reads a document's historical state from git and creates a proposal that,
 * when committed, restores the document to that historical state.
 * Conflict detection, section locks, and human-involvement scoring all apply
 * automatically because the restore goes through the normal proposal pipeline.
 */

import type { WriterIdentity, Proposal, ProposalSection } from "../types/shared.js";
import { getContentRoot, getDataRoot } from "./data-root.js";
import { extractHistoricalTree } from "./git-repo.js";
import { DocumentSkeleton } from "./document-skeleton.js";
import { ContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";
import { createProposal } from "./proposal-repository.js";

export interface RestoreResult {
  proposal: Proposal;
  contentRoot: string;
}

/**
 * Create a proposal that restores a document to its state at a historical commit.
 *
 * Strategy:
 * 1. Create a proposal to get a content overlay directory
 * 2. Extract the historical skeleton + body files from git directly into that overlay
 * 3. Use DocumentSkeleton.fromDisk on the overlay to read the structure (for metadata)
 * 4. Gather current sections too, so the proposal covers all affected sections
 *
 * This avoids custom parsing — all structure reading goes through DocumentSkeleton.
 */
export async function createRestoreProposal(
  docPath: string,
  targetSha: string,
  writer: WriterIdentity,
): Promise<RestoreResult> {
  const dataRoot = getDataRoot();
  const canonicalRoot = getContentRoot();

  // Gather current sections for proposal metadata (before creating proposal)
  const currentSkeleton = await DocumentSkeleton.fromDisk(docPath, canonicalRoot, canonicalRoot);
  const currentHeadingPaths: string[][] = [];
  currentSkeleton.forEachSection((_h, _l, _sf, hp, _ap, isSub) => {
    if (!isSub) currentHeadingPaths.push([...hp]);
  });

  // The document's files in git live under content/<docPath> (skeleton)
  // and content/<docPath>.sections/ (body files + sub-skeletons).
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const skeletonGitPrefix = `content/${normalized}`;
  const sectionsGitPrefix = `content/${normalized}.sections/`;

  // Create proposal with placeholder sections (will update after reading historical structure)
  const { proposal: initialProposal, contentRoot } = await createProposal(
    writer,
    `Restore "${docPath}" to version ${targetSha.slice(0, 8)}`,
    currentHeadingPaths.map((hp) => ({ doc_path: docPath, heading_path: hp })),
  );

  // Extract historical skeleton file into the proposal overlay
  // The skeleton file is at content/<docPath> (e.g. content/my-doc.md)
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { gitShowFile } = await import("./git-repo.js");
  const path = await import("node:path");

  const historicalSkeletonContent = await gitShowFile(dataRoot, targetSha, skeletonGitPrefix);
  const overlaySkeletonPath = path.resolve(contentRoot, ...normalized.split("/"));
  await mkdir(path.dirname(overlaySkeletonPath), { recursive: true });
  await writeFile(overlaySkeletonPath, historicalSkeletonContent, "utf8");

  // Extract historical body files (and sub-skeletons) into the overlay
  await extractHistoricalTree(
    dataRoot,
    targetSha,
    sectionsGitPrefix,
    path.resolve(contentRoot, ...normalized.split("/")) + ".sections",
  );

  // Now read the restored skeleton via DocumentSkeleton (uses existing parsing)
  const restoredSkeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
  const historicalHeadingPaths: string[][] = [];
  restoredSkeleton.forEachSection((_h, _l, _sf, hp, _ap, isSub) => {
    if (!isSub) historicalHeadingPaths.push([...hp]);
  });

  // Update proposal sections to cover union of current + historical heading paths
  const allPaths = new Map<string, string[]>();
  for (const hp of currentHeadingPaths) allPaths.set(hp.join(">>"), hp);
  for (const hp of historicalHeadingPaths) allPaths.set(hp.join(">>"), hp);

  const { updateProposalSections } = await import("./proposal-repository.js");
  const updatedSections: ProposalSection[] = [...allPaths.values()].map((hp) => ({
    doc_path: docPath,
    heading_path: hp,
  }));
  const { proposal } = await updateProposalSections(initialProposal.id, updatedSections);

  return { proposal, contentRoot };
}
