/**
 * Proposal-side heading removal — the ONE proposal entry point for removing a
 * heading while preserving its descendants (the narrow heading-removal module).
 *
 * Executes the content-layer heading-removal engine against the proposal's
 * shadow content tree, records ONLY the effect's `deletedSectionFileIds` in the
 * proposal's identity-based delete overlay, and GROWS the manifest claims with
 * the merge target and every preserved descendant's NEW path. The removed
 * heading's own claim is never dropped — it stays claimed-but-absent, which is
 * the delete signal the manifest-scoped merge reads.
 *
 * Deliberately independent of the subtree-deletion module and of the aggregate
 * `ProposalEditor` surface: heading removal is not a subtree delete, and the
 * quiescence coordinator calls this directly against the DocSession's
 * `inprogress` proposal.
 */

import { ProposalShadowContentLayer } from "./content-layer.js";
import type { HeadingRemovalEffect } from "./document-skeleton.js";
import {
  loadDeletedSectionFiles,
  proposalContentRoot,
  recordDeletedSectionFiles,
  unionCurrentProposalSections,
} from "./proposal-repository.js";
import { getContentRoot } from "./data-root.js";
import type { SectionBody } from "./section-formatting.js";
import type { DocPath, ProposalId, ProposalSectionClaim } from "../types/shared.js";

export async function removeProposalHeading(
  proposalId: ProposalId,
  docPath: DocPath,
  headingPath: string[],
  orphanBody: SectionBody,
): Promise<HeadingRemovalEffect> {
  const shadow = new ProposalShadowContentLayer(
    proposalContentRoot(proposalId, "inprogress"),
    getContentRoot(),
    (claimedDocPath) => loadDeletedSectionFiles(proposalId, claimedDocPath),
  );
  const effect = await shadow.removeHeading(docPath, headingPath, orphanBody);
  await recordDeletedSectionFiles(proposalId, docPath, effect.deletedSectionFileIds);

  const claims: ProposalSectionClaim[] = [];
  if (effect.mergeTarget) {
    claims.push({ doc_path: docPath, heading_path: [...effect.mergeTarget.visibleHeadingPath] });
  }
  for (const { newEntry } of effect.preservedDescendants) {
    claims.push({ doc_path: docPath, heading_path: [...newEntry.headingPath] });
  }
  await unionCurrentProposalSections(proposalId, claims);

  return effect;
}
