import path from "node:path";
import { getContentRoot } from "./data-root.js";
import { resolveDocPathUnderContent, InvalidDocPathError } from "./path-utils.js";
import type { DocStructureNode, HeadingLevel } from "../types/shared.js";
import { ContentLayer, SectionNotFoundError } from "./content-layer.js";
import { DocumentSkeleton } from "./document-skeleton.js";
import { SectionRef } from "../domain/section-ref.js";
import { isBodyHolderShape } from "./section-shape.js";
import type { DocPath } from "../types/shared.js";

export class HeadingNotFoundError extends Error {}

/**
 * Resolve a heading_path to the canonical section file path.
 * Delegates to ContentLayer for all skeleton parsing.
 */
export async function resolveHeadingPath(
  docPath: DocPath,
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

export async function resolveHeadingPathWithLevel(
  docPath: DocPath,
  headingPath: string[],
): Promise<{ path: string; headingLevel: HeadingLevel }> {
  const contentRoot = getContentRoot();
  resolveDocPathUnderContent(contentRoot, docPath);
  const layer = new ContentLayer(contentRoot);
  try {
    const { absolutePath, headingLevel } = await layer.resolveSectionPathWithLevel(docPath, headingPath);
    return { path: absolutePath, headingLevel };
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
  docPath: DocPath,
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
export async function readDocumentStructure(docPath: DocPath): Promise<DocStructureNode[]> {
  const layer = new ContentLayer(getContentRoot());
  return layer.getDocumentStructure(docPath);
}

// ─── Structure flattening helpers ────────────────────────────────

export interface FlatSection {
  headingPath: string[];
  heading: string;
  headingLevel: HeadingLevel;
}

/**
 * Visible heading-path flatteners.
 *
 * Both `flattenStructureWithLevels` and `flattenStructureToHeadingPaths` produce
 * the user-visible list of heading paths for a document. They emit the document-
 * level BFH entry (parentPath empty, body-holder shape) because that's how
 * pre-heading content surfaces in the API. They DROP sub-skeleton body-holder
 * children — body-holder-shape nodes whose `parentPath.length > 0` — because the
 * structural parent's heading already produced the visible entry for that path,
 * and emitting the body-holder would duplicate it.
 *
 * Every production caller is a visible/read surface (agent:reading broadcasts,
 * GET document detail, MCP read tools). If a future caller needs the literal
 * structural shape including nested body-holders, add a separate
 * `*Structural` variant rather than reverting these.
 */

function structureNodeShape(node: DocStructureNode): { heading: string; headingLevel: HeadingLevel } {
  return { heading: node.heading, headingLevel: node.heading_level };
}

function isNestedBodyHolderInStructure(node: DocStructureNode, parentPath: string[]): boolean {
  return isBodyHolderShape(structureNodeShape(node)) && parentPath.length > 0;
}

export function flattenStructureWithLevels(
  nodes: DocStructureNode[],
  parentPath: string[] = [],
): FlatSection[] {
  const result: FlatSection[] = [];
  for (const node of nodes) {
    const isBeforeFirstHeading = isBodyHolderShape(structureNodeShape(node));
    const currentPath = isBeforeFirstHeading ? [...parentPath] : [...parentPath, node.heading];
    if (!isNestedBodyHolderInStructure(node, parentPath)) {
      result.push({ headingPath: currentPath, heading: node.heading, headingLevel: node.heading_level });
    }
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
    const isBeforeFirstHeading = isBodyHolderShape(structureNodeShape(node));
    const currentPath = isBeforeFirstHeading ? [...parentPath] : [...parentPath, node.heading];
    if (!isNestedBodyHolderInStructure(node, parentPath)) {
      result.push(currentPath);
    }
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
export async function resolveAllCanonicalSectionPaths(
  docPath: DocPath,
): Promise<Map<string, ResolvedSection>> {
  return resolveAllSectionPaths(getContentRoot(), docPath);
}

export async function resolveAllSectionPaths(
  rootDir: string,
  docPath: DocPath,
): Promise<Map<string, ResolvedSection>> {
  let skeleton: DocumentSkeleton;
  try {
    skeleton = await DocumentSkeleton.fromSingleRoot(docPath, rootDir);
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
