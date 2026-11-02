import { ProposalShadowContentLayer } from "./content-layer.js";
import type { HeadingRemovalMergeTarget } from "./document-skeleton.js";
import {
  loadDeletedSectionFiles,
  proposalContentRoot,
  unionCurrentProposalSections,
} from "./proposal-repository.js";
import { getContentRoot } from "./data-root.js";
import type { SectionBody } from "./section-formatting.js";
import type { DocPath, ProposalId } from "../types/shared.js";

export async function saveProposalLeadingChunk(
  proposalId: ProposalId,
  docPath: DocPath,
  headingPath: string[],
  chunk: SectionBody,
): Promise<HeadingRemovalMergeTarget> {
  const shadow = new ProposalShadowContentLayer(
    proposalContentRoot(proposalId, "inprogress"),
    getContentRoot(),
    (claimedDocPath) => loadDeletedSectionFiles(proposalId, claimedDocPath),
  );
  const target = await shadow.saveLeadingChunk(docPath, headingPath, chunk);
  await unionCurrentProposalSections(proposalId, [
    { doc_path: docPath, heading_path: [...target.visibleHeadingPath] },
  ]);
  return target;
}
