/**
 * The forest model behind both map presentations (folder map and treemap).
 *
 * The API returns a FLAT typed hit list; the tree is derived here on the client
 * so the two maps, the legend counts, and the inspector filter all read from one
 * structure and cannot disagree. Nodes are folders and documents only — a
 * heading is never a node, it is a hit attached to its document.
 *
 * Pure data: no React, no fetching, no routing.
 */
import type { SearchHitKind, SearchTextMatch } from "../../services/api-client";

/** Hit counts per kind. Every kind is always present, zero when absent. */
export interface HitKindCounts {
  body: number;
  heading: number;
  filename: number;
  path_segment: number;
}

export interface SearchTreeNode {
  /** Canonical path of this node — a folder prefix, or a document path. */
  path: string;
  /** Last path segment (document label keeps the `.md` off, matching the cards). */
  label: string;
  nodeKind: "folder" | "document";
  /** Hits that landed on THIS node, in backend order. */
  directHits: SearchTextMatch[];
  /** Child folders and documents, sorted folders-then-documents by label. */
  children: SearchTreeNode[];
  /** Per-kind counts for the whole subtree, INCLUDING this node's direct hits. */
  descendantCounts: HitKindCounts;
  /** Total hits in the whole subtree, INCLUDING this node's direct hits. */
  totalDescendants: number;
}

export function emptyHitKindCounts(): HitKindCounts {
  return { body: 0, heading: 0, filename: 0, path_segment: 0 };
}

export function addHitKindCounts(target: HitKindCounts, source: HitKindCounts): void {
  target.body += source.body;
  target.heading += source.heading;
  target.filename += source.filename;
  target.path_segment += source.path_segment;
}

export function countHitKind(target: HitKindCounts, kind: SearchHitKind): void {
  target[kind] += 1;
}

/** The synthetic root every forest hangs from, so `/` is always selectable. */
export const SEARCH_FOREST_ROOT_PATH = "/";

function makeNode(path: string, label: string, nodeKind: "folder" | "document"): SearchTreeNode {
  return {
    path,
    label,
    nodeKind,
    directHits: [],
    children: [],
    descendantCounts: emptyHitKindCounts(),
    totalDescendants: 0,
  };
}

function documentLabel(segment: string): string {
  return segment.endsWith(".md") ? segment.slice(0, -".md".length) : segment;
}

function ensureChild(
  parent: SearchTreeNode,
  path: string,
  segment: string,
  nodeKind: "folder" | "document",
): SearchTreeNode {
  const existing = parent.children.find((child) => child.path === path);
  if (existing) {
    if (existing.nodeKind !== nodeKind) {
      // Backend guarantees `path_segment` paths are strict folder prefixes and
      // every other kind carries a `.md` document path, so one path cannot be
      // both. If it ever is, the wire contract broke — say so, do not guess.
      throw new Error(
        `Search forest: ${path} arrived as both a ${existing.nodeKind} and a ${nodeKind}.`,
      );
    }
    return existing;
  }
  const created = makeNode(path, nodeKind === "document" ? documentLabel(segment) : segment, nodeKind);
  parent.children.push(created);
  return created;
}

function sortForest(node: SearchTreeNode): void {
  node.children.sort((a, b) => {
    if (a.nodeKind !== b.nodeKind) return a.nodeKind === "folder" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  for (const child of node.children) sortForest(child);
}

/** Bottom-up: a node's counts are its own direct hits plus every descendant's. */
function accumulateCounts(node: SearchTreeNode): void {
  const counts = emptyHitKindCounts();
  for (const hit of node.directHits) {
    countHitKind(counts, hit.kind);
  }
  let total = node.directHits.length;
  for (const child of node.children) {
    accumulateCounts(child);
    addHitKindCounts(counts, child.descendantCounts);
    total += child.totalDescendants;
  }
  node.descendantCounts = counts;
  node.totalDescendants = total;
}

/**
 * Build the folder/document forest for a flat hit list.
 *
 * Each hit inserts its folder chain; every kind except `path_segment` also gets
 * a document leaf (a `path_segment` hit's path IS the folder, so it attaches
 * there). The synthetic `/` root always exists, so "show everything" is just a
 * selection of the root.
 */
export function buildSearchHitForest(hits: readonly SearchTextMatch[]): SearchTreeNode {
  const root = makeNode(SEARCH_FOREST_ROOT_PATH, SEARCH_FOREST_ROOT_PATH, "folder");

  for (const hit of hits) {
    const segments = hit.doc_path.split("/").filter(Boolean);
    let current = root;
    let prefix = "";
    for (let index = 0; index < segments.length; index += 1) {
      const isLeaf = index === segments.length - 1;
      prefix += `/${segments[index]}`;
      current = ensureChild(current, prefix, segments[index], isLeaf && hit.kind !== "path_segment" ? "document" : "folder");
    }
    current.directHits.push(hit);
  }

  sortForest(root);
  accumulateCounts(root);
  return root;
}

/**
 * EVERY hit under a node, depth-first: the node's own direct hits first, then
 * each child's subtree in display order. No sampling, no cap, no "top N" — the
 * inspector shows the complete list for whatever is selected.
 */
export function collectSubtreeHits(node: SearchTreeNode): SearchTextMatch[] {
  const hits: SearchTextMatch[] = [...node.directHits];
  for (const child of node.children) {
    hits.push(...collectSubtreeHits(child));
  }
  return hits;
}

export function findForestNode(root: SearchTreeNode, path: string): SearchTreeNode | null {
  if (root.path === path) return root;
  for (const child of root.children) {
    const found = findForestNode(child, path);
    if (found) return found;
  }
  return null;
}

/**
 * The hit list the inspector should render for the current selection.
 *
 * `null` means nothing is selected → every hit in the forest. A selected path
 * that is not in the forest (e.g. a stale selection carried across a new
 * search) yields an empty list rather than silently falling back to everything,
 * so the header count and the cards always describe the same thing.
 */
export function hitsForSelection(root: SearchTreeNode, selectedPath: string | null): SearchTextMatch[] {
  if (selectedPath === null) {
    return collectSubtreeHits(root);
  }
  const node = findForestNode(root, selectedPath);
  return node === null ? [] : collectSubtreeHits(node);
}
