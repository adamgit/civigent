import type {
  DocStructureNode,
  GetDocumentSectionsResponse,
} from "../types/shared.js";
// Type-only (erased at runtime): live-sections imports BEFORE_FIRST_HEADING_KEY
// from this module, so a value import here would be a cycle.
import type { RenderSectionRef } from "../types/live-sections";
import { relativeTime } from "../utils/relativeTime";
import type { DocPath } from "../types/shared";

// ─── Helper types ────────────────────────────────────────────────

/**
 * The content-bearing workspace REST section row, exactly as `/sections`
 * returns it. For REST LOADERS and cold-bootstrap derivation ONLY — never the
 * live/render currency. Live topology and page render rows use the body-free
 * identities in `types/live-sections.ts` (`LiveSectionRef` / `RenderSectionRef`);
 * bodies come from the explicit authorities (cold seed / live replica /
 * proposal map), not from this DTO riding along on render state.
 */
export type WorkspaceSectionDto = GetDocumentSectionsResponse["sections"][number];

export interface RecentlyChangedSectionEntry {
  key: string;
  label: string;
  changedAtMs: number;
  changedByName: string;
  /** Committer's canonical id (write-lane badge identity). */
  changedById: string;
  /** Committer kind — drives the write-lane badge's human/agent styling. */
  changedByType: import("../types/shared").WriterType;
}

export interface AgentReadingIndicator {
  key: string;
  /** Reading agent's canonical id (presence-lane badge identity). */
  actorId: string;
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

export function headingPathToLabel(path: string[]): string {
  return path.length === 0 ? "(before first heading)" : path.join(" > ");
}

/** Read the opaque backend-owned fragment key for a section. */
export function getSectionFragmentKey(section: WorkspaceSectionDto): string {
  return section.fragment_key;
}

export function formatRelativeAgeFromMs(changedAtMs: number): string {
  return relativeTime(changedAtMs);
}

export function getDocDisplayName(docPath: DocPath): string {
  const parts = docPath.split("/").filter(Boolean);
  const filename = parts[parts.length - 1] || docPath;
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

/**
 * Identity-aware lazy editor mount window: a fragment mounts an editor when its
 * CURRENT position in the ordered render rows is within one row of the focused
 * fragment's current position. Positions are derived here from the ordered
 * fragment keys per call — never stored focus state.
 */
export function shouldMountEditorForFragment(
  fragmentKey: string,
  focusedFragmentKey: string | null,
  orderedFragmentKeys: readonly string[],
): boolean {
  if (focusedFragmentKey === null) return false;
  const focusedPos = orderedFragmentKeys.indexOf(focusedFragmentKey);
  if (focusedPos < 0) return false;
  const rowPos = orderedFragmentKeys.indexOf(fragmentKey);
  if (rowPos < 0) return false;
  return Math.abs(rowPos - focusedPos) <= 1;
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

export function isDocumentEffectivelyEmpty(
  rows: readonly RenderSectionRef[],
  readBody: (row: RenderSectionRef) => string,
): boolean {
  if (rows.length === 0) return true;
  if (rows.length === 1) {
    const only = rows[0];
    if (only.headingPath.length === 0 && readBody(only).trim() === "") return true;
  }
  return false;
}
