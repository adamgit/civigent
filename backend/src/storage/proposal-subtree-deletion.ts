/**
 * Proposal-side subtree deletion — the destructive section operation (target
 * section PLUS all descendants). Only explicit subtree-delete requests route
 * here; heading removal (heading gone, descendants preserved) is the separate
 * narrow module `proposal-heading-removal.ts`.
 */

import type { ProposalShadowContentLayer } from "./content-layer.js";
import type { FlatEntry } from "./document-skeleton.js";
import { recordDeletedSectionFiles } from "./proposal-repository.js";
import type { DocPath, ProposalId } from "../types/shared.js";

export async function deleteProposalSubtree(
  proposalId: ProposalId,
  shadow: ProposalShadowContentLayer,
  docPath: DocPath,
  headingPath: string[],
): Promise<FlatEntry[]> {
  const removed = await shadow.deleteSubtree(docPath, headingPath);
  // Identity-based delete detection (D3): a whole-subtree delete removes
  // everything it returns — nothing is re-parented — so every removed entry's id
  // is a genuine delete for the manifest-scoped merge to drop by id.
  await recordDeletedSectionFiles(proposalId, docPath, removed.map((e) => e.sectionFile));
  return removed;
}
