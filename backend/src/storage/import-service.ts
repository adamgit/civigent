/**
 * import-service.ts — Shared import pipeline via proposals.
 *
 * importFilesToProposal() is the single codepath that both browser-upload
 * and CLI staging folder import converge on. Everything goes through the
 * proposal system — no direct skeleton creation, no direct git commits.
 */

import { createTransientProposal } from "./proposal-repository.js";
import { mutateProposalContent } from "./mutate-proposal-content.js";
import type { DocPath, ProposalId, WriterIdentity } from "../types/shared.js";

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

export interface ImportFile {
  docPath: DocPath;
  content: string;
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
  onDocumentWritten?: (progress: { index: number; total: number; docPath: DocPath }) => void,
): Promise<ImportFilesToProposalResult> {
  const { id: proposalId, contentRoot: propContentRoot } = await createTransientProposal(
    { id: writer.id, type: writer.type, displayName: writer.displayName, email: writer.email },
    description,
  );

  // Reject .sections/ paths — those are the on-disk storage layout, never
  // assembled documents. Do not sniff bodies for `{{section:}}` markers: that
  // syntax is valid markdown (docs and planning notes use it as examples), and
  // folder export is assembled markdown, so those documents must round-trip.
  // A content-directory copy still fails here because it includes `.sections/`
  // entry paths; scanStagingFolder flags the same trees in the preview.
  for (const file of files) {
    if (file.docPath.includes(".sections/")) {
      throw new ImportValidationError(
        `.sections/ paths are internal storage artifacts and cannot be imported: ${file.docPath}`,
      );
    }
  }

  // Write each whole-document payload + derive the manifest from the normalized
  // on-disk heading structure through the single manifest-owning boundary.
  await mutateProposalContent(
    proposalId,
    {
      kind: "write_document_markdown",
      files: files.map((f) => ({ docPath: f.docPath, markdown: f.content })),
    },
    { onDocumentWritten },
  );

  return { id: proposalId, contentRoot: propContentRoot };
}
