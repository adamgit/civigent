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
import { SectionRef } from "../domain/section-ref.js";
import { buildFragmentContent, EMPTY_BODY, type FragmentContent, type SectionBody } from "../storage/section-formatting.js";
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

/**
 * Read every effective section body for a live document, keyed by heading key,
 * through a proposal-bound read API. When the DocSession has a current
 * `inprogress` proposal, bodies are read from that proposal (staged content
 * wins, canonical inherited where unstaged); otherwise a canonical-only read is
 * used. This is the seed source for CRDT fragment (re)seeding — callers never
 * construct a root-pair content layer themselves.
 */
export async function readLiveSectionBodies(
  docPath: string,
  currentProposalId: ProposalId | null,
): Promise<Map<string, SectionBody>> {
  if (currentProposalId) {
    const { ProposalReader } = await import("../storage/proposal-reader.js");
    return ProposalReader.open(currentProposalId, "inprogress").readAllSections(docPath);
  }
  const { ContentLayer } = await import("../storage/content-layer.js");
  return new ContentLayer(getContentRoot()).readAllSections(docPath);
}

/**
 * Build the full live-fragment seed map for a document, bound to the DocSession's
 * current `inprogress` proposal (else canonical). Resolves the section layout and
 * the effective section bodies through the proposal-bound read APIs above — it
 * never accepts `(primaryRoot, canonicalRoot)` pairs — then assembles one
 * `FragmentContent` per fragment key. Callers seed/rebuild the live Y.Doc by
 * passing the result to `LiveFragmentStringsStore.replaceFragmentStrings(...)`.
 */
export async function buildLiveSeedContentMap(
  docPath: string,
  currentProposalId: ProposalId | null,
): Promise<Map<string, FragmentContent>> {
  const [layout, bodies] = await Promise.all([
    resolveLiveSectionLayout(docPath, currentProposalId),
    readLiveSectionBodies(docPath, currentProposalId),
  ]);
  const contentMap = new Map<string, FragmentContent>();
  for (const entry of layout) {
    const headingKey = SectionRef.headingKey(entry.headingPath);
    const body = bodies.get(headingKey) ?? EMPTY_BODY;
    contentMap.set(entry.fragmentKey, buildFragmentContent(body, entry.level, entry.heading));
  }
  return contentMap;
}
