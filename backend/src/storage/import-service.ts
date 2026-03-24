/**
 * import-service.ts — Shared import pipeline via proposals.
 *
 * importFilesToProposal() is the single codepath that both browser-upload
 * and CLI staging folder import converge on. Everything goes through the
 * proposal system — no direct skeleton creation, no direct git commits.
 */

import { ContentLayer } from "./content-layer.js";
import { getContentRoot } from "./data-root.js";
import { createTransientProposal, updateProposalSections } from "./proposal-repository.js";
import type { ProposalId, WriterIdentity } from "../types/shared.js";

export interface ImportFile {
  docPath: string;
  content: string;
}

export interface ImportFilesToProposalResult {
  id: ProposalId;
  contentRoot: string;
}

/**
 * Import markdown files into the Knowledge Store through a proposal.
 *
 * Creates a proposal, writes each file through importMarkdownDocument
 * (which normalizes sections and manages the skeleton), then updates
 * proposal metadata to match the actual section structure.
 */
export async function importFilesToProposal(
  files: ImportFile[],
  writer: WriterIdentity,
  description: string,
): Promise<ImportFilesToProposalResult> {
  const contentRoot = getContentRoot();

  const { id: proposalId, contentRoot: propContentRoot } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    description,
  );

  // Write each file through importMarkdownDocument — normalizes sections + manages skeleton
  const fContentLayer = new ContentLayer(propContentRoot, new ContentLayer(contentRoot));
  const allSectionTargets: Array<{ doc_path: string; heading_path: string[] }> = [];
  for (const file of files) {
    const targets = await fContentLayer.importMarkdownDocument(file.docPath, file.content);
    allSectionTargets.push(...targets);
  }

  // Update proposal sections to match actual normalized structure
  await updateProposalSections(proposalId, allSectionTargets);

  return { id: proposalId, contentRoot: propContentRoot };
}
