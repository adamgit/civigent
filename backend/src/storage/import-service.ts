/**
 * import-service.ts — Shared import pipeline via proposals.
 *
 * importFilesToProposal() is the single codepath that both browser-upload
 * and CLI staging folder import converge on. Everything goes through the
 * proposal system — no direct skeleton creation, no direct git commits.
 */

import { ContentLayer } from "./content-layer.js";
import { getContentRoot } from "./data-root.js";
import { createProposal, updateProposalSections } from "./proposal-repository.js";
import type { Proposal, WriterIdentity } from "../types/shared.js";

export interface ImportFile {
  docPath: string;
  content: string;
}

export interface ImportFilesToProposalResult {
  proposal: Proposal;
  contentRoot: string;
}

/**
 * Import markdown files into the Knowledge Store through a proposal.
 *
 * Creates a proposal, writes each file through writeAssembledDocument
 * (which normalizes sections and manages the skeleton), then updates
 * proposal metadata to match the actual section structure.
 */
export async function importFilesToProposal(
  files: ImportFile[],
  writer: WriterIdentity,
  description: string,
): Promise<ImportFilesToProposalResult> {
  const contentRoot = getContentRoot();

  // Create proposal with placeholder root sections — will be updated after write
  const initialSections = files.map(f => ({ doc_path: f.docPath, heading_path: [] as string[] }));
  const { proposal, contentRoot: propContentRoot } = await createProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    description,
    initialSections,
  );

  // Write each file through writeAssembledDocument — normalizes sections + manages skeleton
  const fContentLayer = new ContentLayer(propContentRoot, new ContentLayer(contentRoot));
  const allSectionTargets: Array<{ doc_path: string; heading_path: string[] }> = [];
  for (const file of files) {
    const targets = await fContentLayer.writeAssembledDocument(file.docPath, file.content);
    allSectionTargets.push(...targets);
  }

  // Update proposal sections to match actual normalized structure
  await updateProposalSections(proposal.id, allSectionTargets);

  return { proposal, contentRoot: propContentRoot };
}
