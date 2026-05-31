/**
 * Live section layout resolution.
 *
 * A live fragment only has a user-facing section identity when the authoritative
 * skeleton (the DocSession's `inprogress` proposal content tree if present, else
 * canonical) can resolve it (see assumptions.md). This helper walks that skeleton
 * and returns the ordered (fragmentKey, headingPath, heading, level) layout so the
 * DocSession actor can map live Y.Doc fragments back to section identities for
 * materialization.
 */

import { getContentRoot } from "../storage/data-root.js";
import { fragmentKeyFromSectionFile } from "./ydoc-fragments.js";
import type { ProposalId } from "../types/shared.js";

export interface LiveSectionLayoutEntry {
  fragmentKey: string;
  headingPath: string[];
  heading: string;
  level: number;
}

/**
 * Resolve the ordered section layout for a live document. When the DocSession has
 * a current `inprogress` proposal, its content tree is the authoritative skeleton;
 * otherwise canonical is used.
 */
export async function resolveLiveSectionLayout(
  docPath: string,
  currentProposalId: ProposalId | null,
): Promise<LiveSectionLayoutEntry[]> {
  const { DocumentSkeletonInternal } = await import("../storage/document-skeleton.js");
  const { proposalContentRoot } = await import("../storage/proposal-repository.js");

  const canonicalRoot = getContentRoot();
  const skeletonRoot = currentProposalId
    ? proposalContentRoot(currentProposalId, "inprogress")
    : canonicalRoot;

  const skeleton = await DocumentSkeletonInternal.fromDisk(docPath, skeletonRoot, canonicalRoot);
  const entries: LiveSectionLayoutEntry[] = [];
  const seen = new Set<string>();
  skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
    const fragmentKey = fragmentKeyFromSectionFile(sectionFile, headingPath.length === 0);
    if (seen.has(fragmentKey)) return;
    seen.add(fragmentKey);
    entries.push({
      fragmentKey,
      headingPath: [...headingPath],
      heading,
      level,
    });
  });
  return entries;
}
