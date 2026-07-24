/**
 * doc-paths — workspace document-path helpers for the link picker.
 *
 * The picker offers document paths as link targets. This module reads the same
 * workspace tree source used by the sidebar (`apiClient.getWorkspaceTree`) and
 * flattens it to file paths.
 */

import { apiClient } from "../../services/api-client";
import type { DocumentTreeEntry } from "../../types/shared.js";

/** Flatten a document tree to the canonical (leading-slash) file paths. */
export function flattenFilePaths(entries: DocumentTreeEntry[]): string[] {
  const out: string[] = [];
  const walk = (nodes: DocumentTreeEntry[]) => {
    for (const node of nodes) {
      if (node.type === "file") out.push(node.path);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(entries);
  return out;
}

/** Fetch the workspace tree and return its flattened file paths. */
export async function fetchWorkspaceFilePaths(): Promise<string[]> {
  const response = await apiClient.getWorkspaceTree();
  return flattenFilePaths(response.tree);
}

/**
 * Rank/filter document paths against a query for autocomplete. An empty query
 * returns all paths (capped). Matching is case-insensitive substring; paths whose
 * final segment (filename) matches are ranked ahead of mid-path matches.
 */
export function filterDocPaths(paths: string[], query: string, limit = 20): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, limit);

  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) continue;
    const filename = lower.split("/").filter(Boolean).pop() ?? lower;
    const filenameMatch = filename.includes(q);
    // Lower score sorts first: filename matches beat path matches, earlier beats later.
    const score = (filenameMatch ? 0 : 1000) + idx;
    scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}
