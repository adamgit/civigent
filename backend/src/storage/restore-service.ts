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

  // Extract historical files into a temporary location, then assemble and
  // re-write through writeAssembledDocument to ensure normalization.
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { gitShowFile } = await import("./git-repo.js");
  const path = await import("node:path");

  // Extract historical skeleton + body files into the overlay (raw extraction)
  const historicalSkeletonContent = await gitShowFile(dataRoot, targetSha, skeletonGitPrefix);
  const overlaySkeletonPath = path.resolve(contentRoot, ...normalized.split("/"));
  await mkdir(path.dirname(overlaySkeletonPath), { recursive: true });
  await writeFile(overlaySkeletonPath, historicalSkeletonContent, "utf8");

  await extractHistoricalTree(
    dataRoot,
    targetSha,
    sectionsGitPrefix,
    path.resolve(contentRoot, ...normalized.split("/")) + ".sections",
  );

  // Read the historical content as an assembled document, then re-write it
  // through writeAssembledDocument to normalize the structure. This ensures
  // restored content is always correctly split into sections, even if the
  // historical state was itself corrupt (e.g. embedded headings in root body).
  const historicalLayer = new ContentLayer(contentRoot);
  const assembledHistorical = await historicalLayer.readAssembledDocument(docPath);

  // Re-write through writeAssembledDocument (normalizes sections + updates skeleton)
  const normalizedLayer = new ContentLayer(contentRoot);
  const restoredTargets = await normalizedLayer.writeAssembledDocument(docPath, assembledHistorical);

  // Combine current + restored heading paths for proposal sections
  const allPaths = new Map<string, string[]>();
  for (const hp of currentHeadingPaths) allPaths.set(hp.join(">>"), hp);
  for (const t of restoredTargets) allPaths.set(t.heading_path.join(">>"), t.heading_path);

  const { updateProposalSections } = await import("./proposal-repository.js");
  const updatedSections: ProposalSection[] = [...allPaths.values()].map((hp) => ({
    doc_path: docPath,
    heading_path: hp,
  }));
  const { proposal } = await updateProposalSections(initialProposal.id, updatedSections);

  return { proposal, contentRoot };
}
