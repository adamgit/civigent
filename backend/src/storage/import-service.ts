/**
 * import-service.ts — Shared import pipeline via proposals.
 *
 * importFilesToProposal() is the single codepath that both browser-upload
 * and CLI staging folder import converge on. Everything goes through the
 * proposal system — no direct skeleton creation, no direct git commits.
 */

import { ProposalEditor } from "./proposal-editor.js";
import { createTransientProposal, updateProposalSections } from "./proposal-repository.js";
import type { ProposalId, ProposalSection, ProposalStatus, WriterIdentity } from "../types/shared.js";

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

export interface ImportFile {
  docPath: string;
  content: string;
}

/**
 * Shared recipe: write each whole-document markdown payload into a proposal
 * through `ProposalEditor`, then read back the normalized heading paths to
 * build a flat section manifest. The single dedup target for import, MCP
 * filesystem writes, and REST overwrite/patch.
 *
 * Owns ONLY the storage write + manifest derivation — proposal creation,
 * validation, ACL checks, and response shaping stay with the caller.
 */
export async function writeDocumentsToProposalAndBuildManifest(
  proposalId: ProposalId,
  status: ProposalStatus,
  files: ImportFile[],
): Promise<ProposalSection[]> {
  const editor = ProposalEditor.open(proposalId, status);
  const sectionTargets: ProposalSection[] = [];
  for (const file of files) {
    await editor.writeDocumentFromMarkdown(file.docPath, file.content);
    const headingPaths = await editor.listHeadingPaths(file.docPath);
    for (const hp of headingPaths) {
      sectionTargets.push({ doc_path: file.docPath, heading_path: hp });
    }
  }
  return sectionTargets;
}

export interface ImportFilesToProposalResult {
  id: ProposalId;
  contentRoot: string;
}

/**
 * Import markdown files into the Knowledge Store through a proposal.
 *
 * Creates a proposal, writes each file through `upsertDocumentFromMarkdown`
 * (clear/create to live-empty, then root-target upsert), then reads back the
 * resulting heading paths via `listHeadingPaths(...)` to build proposal
 * section metadata. The storage primitive owns ONLY the storage mutation;
 * proposal metadata derivation lives here.
 */
export async function importFilesToProposal(
  files: ImportFile[],
  writer: WriterIdentity,
  description: string,
): Promise<ImportFilesToProposalResult> {
  const { id: proposalId, contentRoot: propContentRoot } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    description,
  );

  // Validate files at import boundary — reject internal storage artifacts
  const SKELETON_MARKER_RE = /\{\{section:\s*\S+\}\}/;
  for (const file of files) {
    if (file.docPath.includes(".sections/")) {
      throw new ImportValidationError(
        `.sections/ paths are internal storage artifacts and cannot be imported: ${file.docPath}`,
      );
    }
    if (SKELETON_MARKER_RE.test(file.content)) {
      throw new ImportValidationError(
        `File appears to be an internal skeleton file, not a valid markdown document: ${file.docPath}`,
      );
    }
  }

  // Write each file through the shared ProposalEditor recipe, then read back
  // the normalized heading paths to build proposal section metadata.
  // Transient proposals live in "pending".
  const allSectionTargets = await writeDocumentsToProposalAndBuildManifest(
    proposalId,
    "pending",
    files,
  );

  // Update proposal sections to match actual normalized structure
  await updateProposalSections(proposalId, allSectionTargets);

  return { id: proposalId, contentRoot: propContentRoot };
}
