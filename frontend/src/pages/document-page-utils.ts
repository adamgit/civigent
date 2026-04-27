import type {
  DocStructureNode,
  GetDocumentSectionsResponse,
} from "../types/shared.js";
import { sectionGlobalKey } from "../types/shared.js";
import { relativeTime } from "../utils/relativeTime";

// ─── Helper types ────────────────────────────────────────────────

/**
 * Per-section persistence state. Each section has exactly one of these states.
 *
 * Transitions:
 *   clean ──[local Y.Doc update on focused section]──► dirty
 *   dirty ──[MSG_UPDATE_RECEIVED]──► received
 *   received ──[content:committed includes this section]──► clean
 *
 * "deleting" is a terminal holding state for sections removed from the Y.Doc.
 *
 * @deprecated Prefer the canonical definition in browser-fragment-replica-store.ts
 */
export type SectionPersistenceState = "clean" | "dirty" | "received" | "deleting";

export interface DeletionPlaceholder {
  fragmentKey: string;
  formerHeading: string;
  /** Index in section list where this placeholder should appear. */
  insertAfterIndex: number;
}

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

export interface PresenceIndicator {
  key: string;
  sectionKey: string;
  writerDisplayName: string;
  writerType: string;
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
