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
import {
  buildFragmentContent,
  stripHeadingFromFragment,
  EMPTY_BODY,
  type FragmentContent,
  type SectionBody,
} from "../storage/section-formatting.js";
import type { ProposalId } from "../types/shared.js";
import { HeadingLevel } from "../types/shared.js";
import type { DocPath } from "../types/shared.js";
import type { DocSession } from "./ydoc-lifecycle.js";

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

type EmptyDocumentDisposition =
  | "existing_empty_document_can_receive_first_edit"
  | "deleted_by_proposal_tombstone"
  | "no_skeleton_at_either_root";

async function classifyEmptyDocument(
  docPath: DocPath,
  skeletonRoot: string,
  canonicalRoot: string,
): Promise<EmptyDocumentDisposition> {
  const { skeletonFileExists, tombstoneFileExists } = await import("../storage/document-skeleton.js");

  if (skeletonRoot !== canonicalRoot && await tombstoneFileExists(docPath, skeletonRoot)) {
    return "deleted_by_proposal_tombstone";
  }

  if (await skeletonFileExists(docPath, skeletonRoot)) {
    return "existing_empty_document_can_receive_first_edit";
  }

  if (skeletonRoot !== canonicalRoot && await skeletonFileExists(docPath, canonicalRoot)) {
    return "existing_empty_document_can_receive_first_edit";
  }

  return "no_skeleton_at_either_root";
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
 * Resolve the ordered section layout for a document from its PERSISTED
 * structure. When the DocSession has a current `inprogress` proposal, its
 * content tree is the authoritative skeleton; otherwise canonical is used.
 *
 * Callers that already hold a `DocSession` should use `resolveLiveSectionLayout(session)`
 * instead — this disk-only resolver is for callers that have only a
 * `(docPath, proposalId)` pair (no live Y.Doc topology to cross-check against).
 */
export async function resolvePersistedSectionLayout(
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
  if (!skeleton.areSkeletonRootsEmpty) return [];

  const disposition = await classifyEmptyDocument(docPath, skeletonRoot, canonicalRoot);
  if (disposition === "existing_empty_document_can_receive_first_edit") {
    return [emptyDocumentFirstEditSection()];
  }
  if (disposition === "deleted_by_proposal_tombstone") {
    return [];
  }
  throw new Error(
    `resolvePersistedSectionLayout: document "${docPath}" has no skeleton at "${skeletonRoot}" nor at "${canonicalRoot}". `
    + `A live session asked for the layout of a document that is not on disk; reporting it as an empty document would be a lie.`,
  );
}

/**
 * Resolve the ordered section layout for a live `DocSession`. This is the
 * topology callers holding a session must use: it trusts the session's live
 * Y.Doc fragments over a possibly-stale on-disk read, and never synthesizes an
 * empty-BFH row while the live Y.Doc actually holds real content — the
 * empty-document bootstrap classification (`classifyEmptyDocument`) is reserved
 * for `constructDocSession` / the disk-only `resolvePersistedSectionLayout`.
 *
 * Falls back from an empty persisted layout to the session's own live fragment
 * keys only when those keys genuinely show nothing but an empty (or absent)
 * before-first-heading fragment; otherwise this throws, because a live Y.Doc
 * that has moved past empty while the persisted structure still reads empty is
 * an invariant violation, not a legitimate empty document.
 */
export async function resolveLiveSectionLayout(session: DocSession): Promise<LiveSectionLayoutEntry[]> {
  const currentProposalId = session.generator.getCurrentProposalId();
  const persistedLayout = await resolvePersistedSectionLayout(session.docPath, currentProposalId);
  if (persistedLayout.length > 0) return persistedLayout;

  const liveKeys = session.liveFragments.getFragmentKeys();
  const hasNonBfhKey = liveKeys.some((key) => key !== BEFORE_FIRST_HEADING_KEY);
  const bfhBody = liveKeys.includes(BEFORE_FIRST_HEADING_KEY)
    ? stripHeadingFromFragment(
        session.liveFragments.readFragmentString(BEFORE_FIRST_HEADING_KEY),
        HeadingLevel.beforeFirstHeading,
      )
    : null;
  const bfhHasContent = bfhBody !== null && String(bfhBody).trim() !== "";
  if (hasNonBfhKey || bfhHasContent) {
    throw new Error(
      `resolveLiveSectionLayout: persisted structure for "${session.docPath}" reads empty, but the live ` +
        `Y.Doc still has ${hasNonBfhKey ? "a registered non-BFH fragment" : "a non-empty before-first-heading fragment"}. ` +
        `Reporting an empty-BFH layout here would contradict the session's own live topology.`,
    );
  }
  return [emptyDocumentFirstEditSection()];
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
    resolvePersistedSectionLayout(docPath, currentProposalId),
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
