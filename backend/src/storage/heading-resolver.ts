import path from "node:path";
import { getContentRoot } from "./data-root.js";
import { resolveDocPathUnderContent, InvalidDocPathError } from "./path-utils.js";
import type { DocStructureNode } from "../types/shared.js";
import { ContentLayer, SectionNotFoundError } from "./content-layer.js";
import { DocumentSkeleton } from "./document-skeleton.js";
import { SectionRef } from "../domain/section-ref.js";

export class HeadingNotFoundError extends Error {}

/**
 * Resolve a heading_path to the canonical section file path.
 * Delegates to ContentLayer for all skeleton parsing.
 */
export async function resolveHeadingPath(
  docPath: string,
  headingPath: string[]
): Promise<string> {
  const contentRoot = getContentRoot();
  // Validate the doc path (throws InvalidDocPathError if bad)
  resolveDocPathUnderContent(contentRoot, docPath);
  const layer = new ContentLayer(contentRoot);
  try {
    return await layer.resolveSectionPath(docPath, headingPath);
  } catch (err) {
    if (err instanceof SectionNotFoundError) throw new HeadingNotFoundError(err.message);
    throw err;
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
  const layer = new ContentLayer(contentRoot);
  try {
    const { absolutePath, level } = await layer.resolveSectionPathWithLevel(docPath, headingPath);
    return { path: absolutePath, level };
  } catch (err) {
    if (err instanceof SectionNotFoundError) throw new HeadingNotFoundError(err.message);
    throw err;
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
  const layer = new ContentLayer(rootContentDir);
  try {
    return await layer.resolveSectionPath(docPath, headingPath);
  } catch (err) {
    if (err instanceof SectionNotFoundError) throw new HeadingNotFoundError(err.message);
    throw err;
  }
}

/**
 * Build the full document structure tree from canonical content.
 * Delegates to ContentLayer which uses DocumentSkeleton internally.
 */
export async function readDocumentStructure(docPath: string): Promise<DocStructureNode[]> {
  const layer = new ContentLayer(getContentRoot());
  return layer.getDocumentStructure(docPath);
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
    const isBeforeFirstHeading = node.level === 0 && node.heading === "";
    const currentPath = isBeforeFirstHeading ? [...parentPath] : [...parentPath, node.heading];
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
    const isBeforeFirstHeading = node.level === 0 && node.heading === "";
    const currentPath = isBeforeFirstHeading ? [...parentPath] : [...parentPath, node.heading];
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
 * Uses DocumentSkeleton.forEachSection which provides authoritative
 * absolute paths for all section types — direct sections, body-holder
 * sections, BFH sections, and nested children. Non-recovery code must
 * never reconstruct section file paths from sectionsDirectory + sectionFile
 * when the skeleton already knows the true body path.
 *
 * @param rootDir - the content root directory (canonical or overlay)
 * @param docPath - the document path (e.g. "/my-doc.md")
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
  for (const entry of skeleton.allContentEntries()) {
    const key = SectionRef.headingKey(entry.headingPath);
    result.set(key, {
      headingPath: [...entry.headingPath],
      absolutePath: entry.absolutePath,
      relativePath: path.relative(rootDir, entry.absolutePath),
    });
  }
  return result;
}

/**
 * Read document structure, checking an overlay root first (e.g. sessions/sections/content/).
 * Uses OverlayContentLayer for overlay+canonical skeleton loading.
 */
export async function readDocumentStructureWithOverlay(
  docPath: string,
  overlayRoot: string,
): Promise<DocStructureNode[]> {
  const { OverlayContentLayer } = await import("./content-layer.js");
  const layer = new OverlayContentLayer(overlayRoot, getContentRoot());
  return layer.getDocumentStructure(docPath);
}
