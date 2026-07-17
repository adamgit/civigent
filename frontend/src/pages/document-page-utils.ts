import type {
  DocStructureNode,
  GetDocumentSectionsResponse,
} from "../types/shared.js";
import { sectionGlobalKey } from "../types/shared.js";
import { relativeTime } from "../utils/relativeTime";

// ─── Helper types ────────────────────────────────────────────────

export type DocumentSection = GetDocumentSectionsResponse["sections"][number];

export interface RecentlyChangedSectionEntry {
  key: string;
  label: string;
  changedAtMs: number;
  changedByName: string;
}

export interface AgentReadingIndicator {
  key: string;
  actorDisplayName: string;
  labels: string[];
  expiresAt: number;
}

export interface PendingProposalIndicator {
  proposalId: string;
  sectionKey: string;
  writerDisplayName: string;
  intent: string;
}

// ─── Pure helper functions ───────────────────────────────────────

export function normalizeDocPath(path: string): string {
  // Canonical form: trim, collapse runs of slashes, ensure exactly one leading `/`.
  const trimmed = path.trim().replace(/\/+/g, "/");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function headingPathToLabel(path: string[]): string {
  return path.length === 0 ? "(before first heading)" : path.join(" > ");
}

/** Read the opaque backend-owned fragment key for a section. */
export function getSectionFragmentKey(section: DocumentSection): string {
  return section.fragment_key;
}

/**
 * Adopt a fresh authoritative section layout into the page's section list,
 * reconciling against the previous list by opaque `fragment_key` (never positional
 * index or heading text). Shared by BOTH topology sources:
 *  - the `content:committed` REST refresh (fresh = `GET …/sections`), and
 *  - the live `doc:structure-changed` event (fresh = the event's `sections`, which
 *    is already the SAME server-authored shape — adopted verbatim, no mapping).
 *
 * Adoption is an identity/order operation, NOT a display-content operation. It
 * is only ever called while a live CRDT session is active (the cold, no-session
 * refresh path uses a full `loadSections` reload instead). While a session is
 * live, the display authority for an existing section is its Y.Doc fragment —
 * painted via `useLiveSectionReplica().paintMarkdown` — NOT the `.content` string on
 * these rows. So for a key that already existed in `prev`, we take order,
 * fragment key, heading/level/path identity and all other structural meta from
 * `fresh`, but keep the previous `.content` as a cold seed/fallback and never
 * install `fresh.content`: after a demotion, `fresh.content` can be a
 * reconstructed `# Heading` (server `prependHeadings`) that no longer matches the
 * live fragment. (Whether the live payload's `.content` lies is a separate P1
 * server concern — we do not sanitize it here; we simply stop treating adopted
 * or preserved `.content` as live display text.) A brand-new key that only
 * appears in `fresh` keeps `fresh.content` as its bootstrap seed until its live
 * fragment exists.
 *
 * Focus is reconciled by fragment identity: it follows the focused fragment to
 * its NEW index, or clears if that fragment no longer exists.
 * `focusedSectionIndexRef` is mutated in place to the reconciled index.
 */
export function adoptFreshSectionLayout(params: {
  prev: DocumentSection[];
  fresh: DocumentSection[];
  focusedSectionIndexRef: { current: number | null };
}): DocumentSection[] {
  const { prev, fresh, focusedSectionIndexRef } = params;
  const prevByFragmentKey = new Map(prev.map((s) => [getSectionFragmentKey(s), s]));
  const nextSections = fresh.map((freshSection) => {
    const fk = getSectionFragmentKey(freshSection);
    const prevSection = prevByFragmentKey.get(fk);
    // Existing live key: identity/order/meta from fresh, but `.content` is cold
    // seed/fallback only — keep the last-known seed, never the (possibly
    // reconstructed) fresh.content. Live display comes from the fragment.
    if (prevSection) return { ...freshSection, content: prevSection.content };
    // New key: no prior seed — fresh.content is the cold bootstrap seed until
    // the live fragment arrives.
    return freshSection;
  });
  // Reconcile focus by fragment identity: keep focus on the focused fragment's NEW
  // index, or clear it if that fragment no longer exists. Special case: when the
  // dropped focused fragment is the bootstrap BFH (dissolved after empty-preamble
  // root-split), hand focus to the first headed section in the fresh layout so
  // the caret follows the promoted heading instead of landing on an invisible row.
  const focusedIndex = focusedSectionIndexRef.current;
  if (focusedIndex !== null && focusedIndex >= 0 && focusedIndex < prev.length) {
    const focusedFk = getSectionFragmentKey(prev[focusedIndex]);
    const newIndex = nextSections.findIndex((s) => getSectionFragmentKey(s) === focusedFk);
    if (newIndex >= 0) {
      focusedSectionIndexRef.current = newIndex;
    } else if (focusedFk === BEFORE_FIRST_HEADING_KEY) {
      const firstHeaded = nextSections.findIndex((s) => s.heading_path.length > 0);
      focusedSectionIndexRef.current = firstHeaded >= 0 ? firstHeaded : null;
    } else if (focusedIndex === 0) {
      // The document's FIRST section (which had no predecessor) was removed at
      // quiescence: a no-predecessor heading-deletion folds its body into BFH, or
      // dissolves BFH when the body is empty. Hand focus to the new leading
      // section — BFH if it was created, else the first remaining section — so the
      // caret is never left on the removed headed key. (A non-first section that
      // vanishes, e.g. a predecessor merge or delete, keeps the null-clear below;
      // the merge-survivor handoff is a separate item.)
      const bfhIndex = nextSections.findIndex(
        (s) => getSectionFragmentKey(s) === BEFORE_FIRST_HEADING_KEY,
      );
      focusedSectionIndexRef.current =
        bfhIndex >= 0 ? bfhIndex : nextSections.length > 0 ? 0 : null;
    } else {
      // A non-first focused fragment was removed at quiescence (heading-deletion
      // merge into its predecessor, or a delete). Observing that delete forces the
      // caret OFF the removed key onto the merge survivor — its predecessor — if
      // that predecessor is still present, else the section that now occupies the
      // removed slot, else null. Never leave focus on a removed key. Order-
      // independent w.r.t. section:gone vs the Yjs binary clear: driven purely by
      // the adopted fresh layout.
      const predecessorFk = getSectionFragmentKey(prev[focusedIndex - 1]);
      const predecessorIndex = nextSections.findIndex(
        (s) => getSectionFragmentKey(s) === predecessorFk,
      );
      if (predecessorIndex >= 0) {
        focusedSectionIndexRef.current = predecessorIndex;
      } else if (nextSections.length > 0) {
        focusedSectionIndexRef.current = Math.min(focusedIndex, nextSections.length - 1);
      } else {
        focusedSectionIndexRef.current = null;
      }
    }
  }
  return nextSections;
}

export function mergeSectionsWithProposalOverlay(
  sections: DocumentSection[],
  decodedDocPath: string | null,
  selectedProposalSectionKeys: Set<string>,
  proposalSections: Map<string, { doc_path: string; heading_path: string[]; content: string }>,
): DocumentSection[] {
  if (!decodedDocPath) return sections;
  if (selectedProposalSectionKeys.size === 0) return sections;

  let changed = false;
  const merged = sections.map((section) => {
    const key = sectionGlobalKey(decodedDocPath, section.heading_path);
    if (!selectedProposalSectionKeys.has(key)) return section;
    const overlay = proposalSections.get(key);
    if (!overlay) return section;
    if (overlay.content === section.content) return section;
    changed = true;
    return {
      ...section,
      content: overlay.content,
    };
  });

  return changed ? merged : sections;
}

export function formatRelativeAgeFromMs(changedAtMs: number): string {
  return relativeTime(changedAtMs);
}

export function getDocDisplayName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const filename = parts[parts.length - 1] || path;
  return filename.replace(/\.md$/, "");
}


/** Derive heading depth from heading_path (before-first-heading = 1). */
export function headingDepth(headingPath: string[]): number {
  return Math.max(1, headingPath.length);
}

/** Derive heading text from heading_path (last segment, or empty for before-first-heading). */
export function headingText(headingPath: string[]): string {
  if (headingPath.length === 0) return "";
  return headingPath[headingPath.length - 1];
}

/** Returns true if section at index i should have an editor mounted. */
export function shouldMountEditor(i: number, focusedIndex: number | null): boolean {
  if (focusedIndex === null) return false;
  return Math.abs(i - focusedIndex) <= 1;
}

/** Recursively count all nodes in a DocStructureNode tree. */
export function countStructureNodes(nodes: { children: unknown[] }[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (Array.isArray(node.children)) {
      count += countStructureNodes(node.children as { children: unknown[] }[]);
    }
  }
  return count;
}

/** Flatten a DocStructureNode tree into a list of heading entries for skeleton rendering. */
export function flattenStructureTree(
  nodes: DocStructureNode[],
  parentPath: string[] = [],
): { headingPath: string[]; level: number }[] {
  const result: { headingPath: string[]; level: number }[] = [];
  for (const node of nodes) {
    const path = [...parentPath, node.heading];
    result.push({ headingPath: path, level: node.level });
    if (node.children?.length) {
      result.push(...flattenStructureTree(node.children, path));
    }
  }
  return result;
}

/** Rough per-section size estimate for display purposes. */
export function estimateDocSize(sectionCount: number): string {
  const estimatedBytes = sectionCount * 500;
  if (estimatedBytes < 1024) return `~${estimatedBytes} B`;
  if (estimatedBytes < 1024 * 1024) return `~${Math.round(estimatedBytes / 1024)} KB`;
  return `~${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Don't show the loading indicator for fast loads — only reveal after this delay. */
export const LOADING_REVEAL_DELAY_MS = 500;

/** How long the pastel highlight stays visible after content:committed. */
export const HIGHLIGHT_DURATION_MS = 3000;

/**
 * Synthetic fragment key for the before-first-heading section — mirrors the
 * backend constant in `backend/src/crdt/ydoc-fragments.ts`. The backend uses the
 * same key for real BFH sections, so an editor bound to this key on a synthetic
 * display row keeps its identity across the synthetic → real transition.
 */
export const BEFORE_FIRST_HEADING_KEY = "section::__beforeFirstHeading__";

/**
 * True when the document has no visible content: either no sections, or just a
 * single before-first-heading (BFH) section with empty/whitespace-only content.
 * After the last named section is deleted the server still returns a BFH row,
 * so `sections.length === 0` alone misses that case.
 */
export function isDocumentEffectivelyEmpty(sections: DocumentSection[]): boolean {
  if (sections.length === 0) return true;
  if (sections.length === 1) {
    const only = sections[0];
    if (only.heading_path.length === 0 && only.content.trim() === "") return true;
  }
  return false;
}
