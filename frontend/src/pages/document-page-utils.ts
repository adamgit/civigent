import type {
  DocStructureNode,
  GetDocumentSectionsResponse,
} from "../types/shared.js";

// ─── Helper types ────────────────────────────────────────────────

/**
 * Per-section persistence state. Each section has exactly one of these states.
 *
 * Transitions:
 *   clean ──[local Y.Doc update on focused section]──► dirty
 *   dirty ──[SESSION_FLUSH_STARTED received]──► pending
 *   pending ──[SESSION_FLUSHED payload includes this key]──► flushed
 *   flushed ──[local Y.Doc update on focused section]──► dirty
 *   clean ──[appears in SESSION_FLUSHED payload]──► flushed  (server knows more)
 *   any ──[content:committed includes this section]──► clean
 *
 * "deleting" is a terminal holding state for sections removed from the Y.Doc.
 */
export type SectionPersistenceState = "clean" | "dirty" | "pending" | "flushed" | "deleting";

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
}

export interface PendingProposalIndicator {
  proposalId: string;
  sectionKey: string;
  writerDisplayName: string;
  intent: string;
}

// ─── Pure helper functions ───────────────────────────────────────

export function normalizeDocPath(path: string): string {
  return path.trim().replace(/^\/+/, "");
}

export function headingPathToLabel(path: string[]): string {
  return path.length === 0 ? "(document root)" : path.join(" > ");
}

/** Build a stable fragment key from a section filename.
 *  Root sections (empty heading at level 0) use "__root__". */
export function fragmentKeyFromSectionFile(sectionFile: string, headingPath: string[]): string {
  const isRoot = headingPath.length === 0;
  if (isRoot) return "section::__root__";
  const stem = sectionFile.replace(/\.md$/, "");
  return "section::" + stem;
}

export function formatRelativeAgeFromMs(changedAtMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - changedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function getDocDisplayName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const filename = parts[parts.length - 1] || path;
  return filename.replace(/\.md$/, "");
}

/** Map human-involvement score to a border color class. */
export function involvementBorderClass(score: number): string {
  if (score > 0.5) return "border-l-blue-600";
  if (score > 0.3) return "border-l-blue-300";
  return "border-l-slate-300";
}

/** Derive heading depth from heading_path (root = 1). */
export function headingDepth(headingPath: string[]): number {
  return Math.max(1, headingPath.length);
}

/** Derive heading text from heading_path (last segment, or empty for root). */
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
