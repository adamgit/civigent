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

import { BEFORE_FIRST_HEADING_KEY, fragmentKeyFromSectionFile } from "./ydoc-fragments.js";
import { SectionRef } from "../domain/section-ref.js";
import { buildFragmentContent, EMPTY_BODY, type FragmentContent, type SectionBody } from "../storage/section-formatting.js";
import type { ProposalId } from "../types/shared.js";
import { HeadingLevel } from "../types/shared.js";
import type { DocPath } from "../types/shared.js";

export interface LiveSectionLayoutEntry {
  fragmentKey: string;
  headingPath: string[];
  heading: string;
  headingLevel: HeadingLevel;
}

function emptyDocumentFirstEditSection(): LiveSectionLayoutEntry {
  return {
    fragmentKey: BEFORE_FIRST_HEADING_KEY,
    headingPath: [],
    heading: "",
    headingLevel: HeadingLevel.beforeFirstHeading,
  };
}

async function existingEmptyDocumentCanReceiveFirstEdit(
  docPath: DocPath,
  skeletonRoot: string,
  canonicalRoot: string,
): Promise<boolean> {
  const { skeletonFileExists, tombstoneFileExists } = await import("../storage/document-skeleton.js");

  if (skeletonRoot !== canonicalRoot && await tombstoneFileExists(docPath, skeletonRoot)) {
    return false;
  }

  if (await skeletonFileExists(docPath, skeletonRoot)) {
    return true;
  }

  return skeletonRoot !== canonicalRoot && await skeletonFileExists(docPath, canonicalRoot);
}

function resolvePersistedLiveSectionLayout(
  skeleton: { forEachVisibleSection: (visitor: (heading: string, headingLevel: HeadingLevel, sectionFile: string, headingPath: string[]) => void) => void },
): LiveSectionLayoutEntry[] {
  const entries: LiveSectionLayoutEntry[] = [];
  const seen = new Set<string>();
  skeleton.forEachVisibleSection((heading, headingLevel, sectionFile, headingPath) => {
    const fragmentKey = fragmentKeyFromSectionFile(sectionFile, headingPath.length === 0);
    if (seen.has(fragmentKey)) return;
    seen.add(fragmentKey);
    entries.push({
      fragmentKey,
      headingPath: [...headingPath],
      heading,
      headingLevel,
    });
  });
  return entries;
}

/**
 * Resolve the ordered section layout for a live document. When the DocSession has
 * a current `inprogress` proposal, its content tree is the authoritative skeleton;
 * otherwise canonical is used.
 */
export async function resolveLiveSectionLayout(
  docPath: DocPath,
  currentProposalId: ProposalId | null,
): Promise<LiveSectionLayoutEntry[]> {
  const { DocumentSkeletonInternal } = await import("../storage/document-skeleton.js");
  const { effectiveSkeletonRootPair, loadDeletedSectionFiles } = await import("../storage/proposal-repository.js");

  const { skeletonRoot, canonicalRoot } = effectiveSkeletonRootPair(currentProposalId);

  // Manifest-overlay (U3 / D5): the LIVE structure merges like EVERY other proposal
  // read — current canonical overlaid by the proposal's structural changes, with a
  // section the user deleted this session dropped by its canonical section-file id
  // (identity-based delete detection). A section canonical gained after the session
  // opened is inherited because its id is not deleted. There is NO live wholesale
  // opt-out. With no current proposal the skeleton root IS canonical, so `fromDisk`
  // takes the canonical-only path and the deleted ids are irrelevant (left undefined).
  const deletedSectionFiles = currentProposalId
    ? await loadDeletedSectionFiles(currentProposalId, docPath)
    : undefined;
  const skeleton = await DocumentSkeletonInternal.fromDisk(docPath, skeletonRoot, canonicalRoot, deletedSectionFiles);
  const persistedLayout = resolvePersistedLiveSectionLayout(skeleton);
  if (persistedLayout.length > 0) return persistedLayout;
  if (skeleton.areSkeletonRootsEmpty && await existingEmptyDocumentCanReceiveFirstEdit(docPath, skeletonRoot, canonicalRoot)) {
    return [emptyDocumentFirstEditSection()];
  }
  return [];
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
  docPath: DocPath,
  currentProposalId: ProposalId | null,
): Promise<Map<string, SectionBody>> {
  if (currentProposalId) {
    const { ProposalReader } = await import("../storage/proposal-reader.js");
    return ProposalReader.open(currentProposalId, "inprogress").readAllEffectiveSections(docPath);
  }
  const { CanonicalReader } = await import("../storage/canonical-reader.js");
  return CanonicalReader.open().readAllEffectiveSections(docPath);
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
  docPath: DocPath,
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
    contentMap.set(entry.fragmentKey, buildFragmentContent(body, entry.headingLevel, entry.heading));
  }
  return contentMap;
}
