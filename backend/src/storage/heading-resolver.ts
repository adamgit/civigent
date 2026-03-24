import path from "node:path";
import { getContentRoot } from "./data-root.js";
import { resolveDocPathUnderContent, InvalidDocPathError } from "./path-utils.js";
import type { DocStructureNode } from "../types/shared.js";
import { DocumentSkeleton } from "./document-skeleton.js";
import { ContentLayer } from "./content-layer.js";
import { SectionRef } from "../domain/section-ref.js";

export class HeadingNotFoundError extends Error {}

/**
 * Resolve a heading_path to the canonical section file path.
 * Delegates to DocumentSkeleton for all skeleton parsing.
 */
export async function resolveHeadingPath(
  docPath: string,
  headingPath: string[]
): Promise<string> {
  const contentRoot = getContentRoot();
  // Validate the doc path (throws InvalidDocPathError if bad)
  resolveDocPathUnderContent(contentRoot, docPath);
  const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
  try {
    return skeleton.resolve(headingPath).absolutePath;
  } catch (err) {
    throw new HeadingNotFoundError((err as Error).message);
  }
}

/**
 * Like resolveHeadingPath but also returns the heading level from the skeleton.
 * Returns { path, level } where level is the markdown heading depth (1-6), or 0 for root.
 */
export async function resolveHeadingPathWithLevel(
  docPath: string,
  headingPath: string[],
): Promise<{ path: string; level: number }> {
  const contentRoot = getContentRoot();
  resolveDocPathUnderContent(contentRoot, docPath);
  const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
  try {
    const entry = skeleton.resolve(headingPath);
    return { path: entry.absolutePath, level: entry.level };
  } catch (err) {
    throw new HeadingNotFoundError((err as Error).message);
  }
}

/**
 * Resolve a heading_path under an arbitrary root directory (used for draft
 * folders that mirror canonical structure).
 */
export async function resolveHeadingPathUnderRoot(
  rootContentDir: string,
  docPath: string,
  headingPath: string[]
): Promise<string> {
  if (headingPath.length === 0) {
    throw new InvalidDocPathError("heading_path must have at least one element.");
  }
  const skeleton = await DocumentSkeleton.fromDisk(docPath, rootContentDir, rootContentDir);
  try {
    return skeleton.resolve(headingPath).absolutePath;
  } catch (err) {
    throw new HeadingNotFoundError((err as Error).message);
  }
}

/**
 * Build the full document structure tree from canonical content.
 * Delegates to DocumentSkeleton which uses file-system nesting (sub-skeleton
 * files) rather than level-based nesting.
 */
export async function readDocumentStructure(docPath: string): Promise<DocStructureNode[]> {
  const contentRoot = getContentRoot();
  const skeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
  return skeleton.structure;
}

// ─── Structure flattening helpers ────────────────────────────────

export interface FlatSection {
  headingPath: string[];
  heading: string;
  level: number;
}

export function flattenStructureWithLevels(
  nodes: DocStructureNode[],
  parentPath: string[] = [],
): FlatSection[] {
  const result: FlatSection[] = [];
  for (const node of nodes) {
    const isRoot = node.level === 0 && node.heading === "";
    const currentPath = isRoot ? [...parentPath] : [...parentPath, node.heading];
    result.push({ headingPath: currentPath, heading: node.heading, level: node.level });
    if (node.children?.length) {
      result.push(...flattenStructureWithLevels(node.children, currentPath));
    }
  }
  return result;
}

export function flattenStructureToHeadingPaths(
  nodes: DocStructureNode[],
  parentPath: string[] = [],
): string[][] {
  const result: string[][] = [];
  for (const node of nodes) {
    const isRoot = node.level === 0 && node.heading === "";
    const currentPath = isRoot ? [...parentPath] : [...parentPath, node.heading];
    result.push(currentPath);
    if (node.children?.length) {
      result.push(...flattenStructureToHeadingPaths(node.children, currentPath));
    }
  }
  return result;
}

/**
 * Get the canonical relative path of a section file (relative to content root).
 * Used to construct draft mirror paths.
 */
export function getCanonicalRelativePath(absoluteSectionPath: string): string {
  const contentRoot = getContentRoot();
  return path.relative(contentRoot, absoluteSectionPath);
}

// ─── Bulk resolution ─────────────────────────────────────────────

export interface ResolvedSection {
  headingPath: string[];
  /** Absolute path to the section file under the given root */
  absolutePath: string;
  /** Path relative to the root directory */
  relativePath: string;
}

/**
 * Resolve ALL section file paths for a document.
 * Delegates to DocumentSkeleton which provides canonical heading paths
 * and absolute file paths via its flat view.
 *
 * @param rootDir - the content root directory (canonical or overlay)
 * @param docPath - the document path (e.g. "my-doc.md")
 * @returns Map keyed by headingPath.join(">>") → ResolvedSection
 */
export async function resolveAllSectionPaths(
  rootDir: string,
  docPath: string,
): Promise<Map<string, ResolvedSection>> {
  let skeleton: DocumentSkeleton;
  try {
    skeleton = await DocumentSkeleton.fromDisk(docPath, rootDir, rootDir);
  } catch {
    return new Map(); // skeleton doesn't exist (e.g. overlay root with no changes)
  }

  const result = new Map<string, ResolvedSection>();
  skeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
    const key = SectionRef.headingKey(headingPath);
    result.set(key, {
      headingPath: [...headingPath],
      absolutePath,
      relativePath: path.relative(rootDir, absolutePath),
    });
  });
  return result;
}

/**
 * Read document structure, checking an overlay root first (e.g. sessions/docs/content/).
 * If the skeleton exists in the overlay, use it; otherwise fall back to canonical.
 * Delegates to DocumentSkeleton which handles overlay/canonical fallback.
 */
export async function readDocumentStructureWithOverlay(
  docPath: string,
  overlayRoot: string,
): Promise<DocStructureNode[]> {
  const canonical = new ContentLayer(getContentRoot());
  const overlay = new ContentLayer(overlayRoot, canonical);
  return overlay.getDocumentStructure(docPath);
}
