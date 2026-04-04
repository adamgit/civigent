/**
 * DocumentSkeleton — In-memory index of a document's heading structure.
 *
 * ## Why it exists
 *
 * Section body files are stored under random IDs (e.g. sec_abc123_xyz.md),
 * decoupled from heading text. You cannot locate a body file from its heading
 * path alone. The skeleton file is the indirection layer: it maps the heading
 * tree to section file IDs, and the .sections/ directory hierarchy maps those
 * IDs to absolute paths on disk.
 *
 * DocumentSkeleton parses that structure into an in-memory tree and answers one
 * question: given a heading path like ["Overview", "Details"], where is the body
 * file on disk?
 *
 * ## Class hierarchy
 *
 * DocumentSkeleton — public, readonly. All query methods, no mutation.
 * DocumentSkeletonInternal — restricted. Adds mutation, persistence, and
 *   structural write methods. Only used by OverlayContentLayer internals,
 *   recovery-layers.ts, and callers that need to modify skeleton structure.
 *
 * ## What it owns on disk
 *
 * Skeleton files only — the files containing {{section: filename.md}} markers.
 * Internal persistence helpers write these files. Nothing else.
 *
 * ## What it must never do
 *
 * - Read section body files. That is ContentLayer's job.
 * - Copy or move files between roots. That is the commit pipeline's job.
 * - Know about a canonical root. It was constructed for one root and resolves
 *   all paths under that root. Canonical is not its concern.
 * - Swallow errors on behalf of callers. If a heading is not found, throw.
 *   Whether that is fatal is the caller's decision, not the skeleton's.
 */

import path from "node:path";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import type { DocStructureNode } from "../types/shared.js";
import { normalizeDocPath } from "./path-utils.js";

// ─── Skeleton file format helpers ────────────────────────────────
// These are the canonical parsers/serializers for skeleton file content.
// They live here (not in markdown-sections.ts) because DocumentSkeleton
// is the single owner of all skeleton file I/O.

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const SECTION_MARKER_RE = /^\{\{section:\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}$/;

export interface SkeletonEntry {
  heading: string;
  level: number;
  sectionFile: string;
}

export function parseSkeletonToEntries(skeleton: string): SkeletonEntry[] {
  const lines = skeleton.split(/\r?\n/);
  const entries: SkeletonEntry[] = [];
  let pendingHeading: { text: string; depth: number } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      pendingHeading = {
        text: headingMatch[2].trim(),
        depth: headingMatch[1].length,
      };
      continue;
    }

    const markerMatch = SECTION_MARKER_RE.exec(trimmed);
    if (markerMatch && pendingHeading) {
      entries.push({
        heading: pendingHeading.text,
        level: pendingHeading.depth,
        sectionFile: markerMatch[1].trim(),
      });
      pendingHeading = null;
      continue;
    }
    if (markerMatch && !pendingHeading) {
      entries.push({
        heading: "",
        level: 0,
        sectionFile: markerMatch[1].trim(),
      });
      continue;
    }

    if (trimmed === "") continue;
    pendingHeading = null;
  }

  return entries;
}

export function serializeSkeletonEntries(entries: SkeletonEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.level === 0 && entry.heading === "") {
      // Before-first-heading section: no heading line, just the section directive
      lines.push(`{{section: ${entry.sectionFile}}}`);
    } else {
      lines.push("");
      lines.push(`${"#".repeat(entry.level)} ${entry.heading}`);
      lines.push(`{{section: ${entry.sectionFile}}}`);
    }
  }
  if (lines.length === 0) return "";
  return lines.join("\n").replace(/^\n+/, "") + "\n";
}

/** The directory suffix used for section body files and sub-skeletons. */
export const SECTIONS_DIR_SUFFIX = ".sections";
export const TOMBSTONE_SUFFIX = ".tombstone";

export type OverlayDocumentState = "missing" | "live" | "tombstone";


export function resolveSkeletonPath(docPath: string, contentRoot: string): string {
  return path.resolve(contentRoot, ...normalizeDocPath(docPath).split("/"));
}

export function resolveTombstonePath(docPath: string, overlayRoot: string): string {
  return resolveSkeletonPath(docPath, overlayRoot) + TOMBSTONE_SUFFIX;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function skeletonFileExists(docPath: string, contentRoot: string): Promise<boolean> {
  return fileExists(resolveSkeletonPath(docPath, contentRoot));
}

export async function readOverlayDocumentState(
  docPath: string,
  overlayRoot: string,
  canonicalRoot: string,
): Promise<OverlayDocumentState> {
  if (overlayRoot !== canonicalRoot && await fileExists(resolveTombstonePath(docPath, overlayRoot))) {
    return "tombstone";
  }
  if (await skeletonFileExists(docPath, overlayRoot)) return "live";
  if (await skeletonFileExists(docPath, canonicalRoot)) return "live";
  return "missing";
}

/**
 * Generate a unique section filename from a heading text.
 * Only for headed sections — produces `sec_<slug>_<id>.md`.
 * For before-first-heading sections, use generateBeforeFirstHeadingFilename().
 * For sub-skeleton body holders, use generateSectionBodyFilename().
 *
 * INVARIANT: The generated filename stem (without .md) must NEVER equal "__beforeFirstHeading__",
 * which is the synthetic constant used for before-first-heading fragment keys. The `sec_` prefix
 * guarantees this. The `--before-first-heading--` and `--section-body--` families also cannot
 * collide since `sec_` never starts with `--`.
 */
/**
 * Inverse of generateSectionFilename: extract a human-readable name from a section filename.
 * "sec_my_heading_abc123.md" → "my heading abc123"
 */
export function sectionFileToName(sectionFile: string): string {
  return sectionFile.replace(/\.md$/, "").replace(/^sec_/, "").replace(/_/g, " ");
}

/** Case-insensitive heading comparison. */
export function headingsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Generate a URL/filename-safe slug from arbitrary text. */
export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function generateSectionFilename(heading: string): string {
  const slug = generateSlug(heading);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `sec_${slug}_${randomSuffix}.md`;
}

/** Generate a unique filename for a before-first-heading section body file.
 *  Uses the `--before-first-heading--<id>.md` family, which cannot collide
 *  with heading-derived `sec_<slug>_<id>.md` filenames. */
export function generateBeforeFirstHeadingFilename(): string {
  const id = Math.random().toString(36).slice(2, 8);
  return `--before-first-heading--${id}.md`;
}

/** Generate a unique filename for a sub-skeleton body holder (the implicit
 *  root child of a headed section that has children).
 *  Uses the `--section-body--<id>.md` family, which cannot collide
 *  with heading-derived `sec_<slug>_<id>.md` or `--before-first-heading--` filenames. */
export function generateSectionBodyFilename(): string {
  const id = Math.random().toString(36).slice(2, 8);
  return `--section-body--${id}.md`;
}

// ─── Types ───────────────────────────────────────────────────────

export interface SkeletonNode {
  heading: string;
  level: number;
  sectionFile: string;
  children: SkeletonNode[];
}

export interface FlatEntry {
  headingPath: string[];
  heading: string;
  level: number;
  sectionFile: string;
  /** Absolute path to the section body file under the active root */
  absolutePath: string;
  /**
   * True if this entry's file is a sub-skeleton (listing children), not a body file.
   * Body content for this heading path lives in a root child entry instead.
   * Consumers should skip sub-skeleton entries when reading/writing body content.
   */
  isSubSkeleton: boolean;
}


export interface ReplacementResult {
  /** Entries removed from the flat list */
  removed: FlatEntry[];
  /** Entries added to the flat list (in order, matching input newSections order) */
  added: FlatEntry[];
}

// ─── DocumentSkeleton (readonly) ────────────────────────────────

export class DocumentSkeleton {
  readonly docPath: string;
  protected roots: SkeletonNode[];
  protected _overlayPersisted: boolean = false;
  protected _overlayTombstoned: boolean = false;
  protected readonly overlayRoot: string;

  protected constructor(
    docPath: string,
    roots: SkeletonNode[],
    overlayRoot: string,
  ) {
    this.docPath = docPath;
    this.roots = roots;
    this.overlayRoot = overlayRoot;
  }

  /** True when the overlay contained a skeleton file (vs falling back to canonical). */
  get overlayPersisted(): boolean { return this._overlayPersisted; }

  /** True when the overlay contains a tombstone marker for this document. */
  get overlayTombstoned(): boolean { return this._overlayTombstoned; }

  /** True when the loaded skeleton tree has zero section entries. */
  get isEmpty(): boolean { return this.roots.length === 0; }

  /**
   * Depth-first visitor over all sections. Zero intermediate allocation.
   *
   * headingPath is a shared mutable array — push/pop during walk.
   * Callers must copy it (e.g. [...headingPath]) if they retain it.
   */
  /**
   * Iterate all nodes including sub-skeleton entries.
   * Use this for structural operations (persist, diff) that need sub-skeleton directory paths.
   */
  forEachNode(
    cb: (
      heading: string,
      level: number,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
      isSubSkeleton: boolean,
    ) => void,
  ): void {
    const hp: string[] = [];
    this.walkNodes(this.roots, hp, this.skeletonPath, cb);
  }

  /**
   * Iterate content sections only — skips sub-skeleton entries.
   * Use this for content/API callers that should never see sub-skeleton nodes.
   */
  forEachSection(
    cb: (
      heading: string,
      level: number,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
    ) => void,
  ): void {
    this.forEachNode((heading, level, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
      if (!isSubSkeleton) cb(heading, level, sectionFile, headingPath, absolutePath);
    });
  }

  protected walkNodes(
    nodes: SkeletonNode[],
    hp: string[],
    parentSkeletonPath: string,
    cb: (
      heading: string,
      level: number,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
      isSubSkeleton: boolean,
    ) => void,
  ): void {
    const sectionsDir = `${parentSkeletonPath}.sections`;
    for (const node of nodes) {
      const isBfh = node.level === 0 && node.heading === "";
      if (!isBfh) hp.push(node.heading);
      const absPath = path.join(sectionsDir, node.sectionFile);
      const isSubSkeleton = node.children.length > 0;
      cb(node.heading, node.level, node.sectionFile, hp, absPath, isSubSkeleton);
      if (isSubSkeleton) {
        this.walkNodes(node.children, hp, absPath, cb);
      }
      if (!isBfh) hp.pop();
    }
  }

  /** Convert tree to DocStructureNode[] for API responses. */
  get structure(): DocStructureNode[] {
    return this.toDocStructureNodes(this.roots);
  }

  protected toDocStructureNodes(nodes: SkeletonNode[]): DocStructureNode[] {
    return nodes.map(n => ({
      heading: n.heading,
      level: n.level,
      children: this.toDocStructureNodes(n.children),
    }));
  }

  /**
   * Resolve the before-first-heading section directly from this.roots — no flat materialization.
   * Returns null if the skeleton is empty (tombstone) or has no before-first-heading section.
   */
  expectBeforeFirstHeading(): FlatEntry | null {
    const rootNode = this.roots.find(n => n.level === 0 && n.heading === "");
    if (!rootNode) {
      return null;
    }
    const sectionsDir = `${this.skeletonPath}.sections`;
    // If root has children, follow through to its root child (body file)
    if (rootNode.children.length > 0) {
      const rootChild = rootNode.children.find(c => c.level === 0 && c.heading === "");
      if (rootChild) {
        const absPath = path.join(sectionsDir, rootNode.sectionFile);
        const childSectionsDir = `${absPath}.sections`;
        return {
          headingPath: [],
          heading: rootNode.heading,
          level: rootNode.level,
          sectionFile: rootChild.sectionFile,
          absolutePath: path.join(childSectionsDir, rootChild.sectionFile),
          isSubSkeleton: false,
        };
      }
    }
    return {
      headingPath: [],
      heading: rootNode.heading,
      level: rootNode.level,
      sectionFile: rootNode.sectionFile,
      absolutePath: path.join(sectionsDir, rootNode.sectionFile),
      isSubSkeleton: false,
    };
  }

  /**
   * Resolve a section by its section file ID (filename stem, e.g. "sec_abc123def").
   * Uses a recursive tree walk with early return — no flat materialization.
   * Throws if not found.
   */
  expectByFileId(sectionFileId: string): FlatEntry {
    if (sectionFileId === "__beforeFirstHeading__") {
      const root = this.expectBeforeFirstHeading();
      if (!root) {
        throw new Error(`No before-first-heading section in ${this.docPath}. The document may have no content before its first heading.`);
      }
      return root;
    }

    const targetFile = sectionFileId.endsWith(".md") ? sectionFileId : sectionFileId + ".md";
    const result = this.walkFindFile(this.roots, [], this.skeletonPath, targetFile);
    if (result) return result;

    throw new Error(
      `Skeleton integrity error: section file "${sectionFileId}" not found in ${this.docPath}`
    );
  }

  /**
   * Find a section by its section file ID (filename stem, e.g. "sec_abc123def").
   * Returns null if not found (no throw). Prefer this over expectByFileId when
   * callers need find-or-null semantics.
   */
  findByFileId(sectionFileId: string): FlatEntry | null {
    if (sectionFileId === "__beforeFirstHeading__") {
      return this.expectBeforeFirstHeading();
    }

    const targetFile = sectionFileId.endsWith(".md") ? sectionFileId : sectionFileId + ".md";
    return this.walkFindFile(this.roots, [], this.skeletonPath, targetFile);
  }

  protected walkFindFile(
    nodes: SkeletonNode[],
    parentPath: string[],
    parentSkeletonPath: string,
    targetFile: string,
  ): FlatEntry | null {
    const sectionsDir = `${parentSkeletonPath}.sections`;
    for (const node of nodes) {
      const isBfh = node.level === 0 && node.heading === "";
      const hp = isBfh ? parentPath : [...parentPath, node.heading];
      const absPath = path.join(sectionsDir, node.sectionFile);
      if (node.sectionFile === targetFile) {
        return {
          headingPath: [...hp],
          heading: node.heading,
          level: node.level,
          sectionFile: node.sectionFile,
          absolutePath: absPath,
          isSubSkeleton: node.children.length > 0,
        };
      }
      if (node.children.length > 0) {
        const found = this.walkFindFile(node.children, hp, absPath, targetFile);
        if (found) return found;
      }
    }
    return null;
  }

  /** Look up a section by heading path. Returns null if not found. */
  find(headingPath: string[]): FlatEntry | null {
    // Before-first-heading section: headingPath=[]
    if (headingPath.length === 0) {
      return this.expectBeforeFirstHeading();
    }

    let nodes = this.roots;
    let currentSkeletonPath = this.skeletonPath;
    const resolvedPath: string[] = [];

    for (let i = 0; i < headingPath.length; i++) {
      const target = headingPath[i];
      const node = nodes.find(n => headingsEqual(n.heading, target));
      if (!node) return null;
      resolvedPath.push(node.heading);
      const sectionsDir = `${currentSkeletonPath}.sections`;
      const absPath = path.join(sectionsDir, node.sectionFile);

      if (i === headingPath.length - 1) {
        // If this node has children, its file is a sub-skeleton — follow through
        // to the root child (level=0, heading="") which holds the actual body content.
        if (node.children.length > 0) {
          const rootChild = node.children.find(c => c.level === 0 && c.heading === "");
          if (rootChild) {
            const childSectionsDir = `${absPath}.sections`;
            return {
              headingPath: [...resolvedPath],
              heading: node.heading,
              level: node.level,
              sectionFile: rootChild.sectionFile,
              absolutePath: path.join(childSectionsDir, rootChild.sectionFile),
              isSubSkeleton: false,
            };
          }
        }
        return {
          headingPath: [...resolvedPath],
          heading: node.heading,
          level: node.level,
          sectionFile: node.sectionFile,
          absolutePath: absPath,
          isSubSkeleton: false,
        };
      }

      currentSkeletonPath = absPath;
      nodes = node.children;
    }

    return null;
  }

  /** Resolve a section by heading path. Throws if not found. */
  expect(headingPath: string[]): FlatEntry {
    const entry = this.find(headingPath);
    if (!entry) {
      if (headingPath.length === 0) {
        throw new Error(`No before-first-heading section in ${this.docPath}. The document may have no content before its first heading.`);
      }
      throw new Error(
        `Skeleton integrity error: heading path [${headingPath.join(" > ")}] not found in ${this.docPath}`
      );
    }
    return entry;
  }

  /** Check whether a heading path exists in the skeleton. */
  has(headingPath: string[]): boolean {
    return this.find(headingPath) !== null;
  }

  /**
   * Return all content FlatEntry[] for the entire document (no file I/O).
   * Sub-skeleton entries are excluded — only body-file entries are returned.
   * Use this instead of subtreeEntries([]) for whole-document enumeration.
   */
  allContentEntries(): FlatEntry[] {
    const entries: FlatEntry[] = [];
    this.forEachSection((heading, level, sectionFile, hp, absolutePath) => {
      entries.push({ headingPath: [...hp], heading, level, sectionFile, absolutePath, isSubSkeleton: false });
    });
    return entries;
  }

  /**
   * Return FlatEntry[] for the subtree rooted at headingPath (no file I/O).
   * Sub-skeleton entries are excluded — only body-file entries are returned.
   *
   * ILLEGAL to call with headingPath=[]. Use allContentEntries() for
   * whole-document enumeration, or expectBeforeFirstHeading() for the
   * before-first-heading section.
   */
  subtreeEntries(headingPath: string[]): FlatEntry[] {
    if (headingPath.length === 0) {
      throw new Error(
        "subtreeEntries([]) is illegal — use allContentEntries() for whole-document enumeration, " +
        "or expectBeforeFirstHeading() for the before-first-heading section"
      );
    }
    const parentPath = headingPath.slice(0, -1);
    const target = headingPath[headingPath.length - 1];
    const siblings = this.findSiblingList(parentPath);
    const node = siblings.find(n => headingsEqual(n.heading, target));
    if (!node) {
      throw new Error(
        `Skeleton integrity error: heading "${target}" not found in ${this.docPath} ` +
        `at path [${parentPath.join(" > ")}]`
      );
    }
    return this.flattenNode(node, parentPath, this.resolveSkeletonPathFor(parentPath))
      .filter(e => !e.isSubSkeleton);
  }

  // --- Static factories ---

  /**
   * Create a tombstone marker file at the given doc path in the overlay root.
   * Auto-persists atomically; returns a readonly instance.
   */
  static async createTombstone(
    docPath: string,
    overlayRoot: string,
  ): Promise<DocumentSkeleton> {
    const skeleton = new DocumentSkeleton(docPath, [], overlayRoot);
    const tombstonePath = resolveTombstonePath(docPath, overlayRoot);
    await mkdir(path.dirname(tombstonePath), { recursive: true });
    await rm(skeleton.skeletonPath, { force: true });
    await rm(`${skeleton.skeletonPath}.sections`, { recursive: true, force: true });
    await writeFile(
      tombstonePath,
      `This file marks file ${normalizeDocPath(docPath)} to be deleted when this proposal is committed\n`,
      "utf8",
    );
    skeleton._overlayPersisted = true;
    skeleton._overlayTombstoned = true;
    return skeleton;
  }

  /**
   * Derive the sections directory path for a given document.
   * This is where all body files and sub-skeletons live on disk.
   */
  static sectionsDir(docPath: string, contentRoot: string): string {
    return resolveSkeletonPath(docPath, contentRoot) + ".sections";
  }

  static async fromDisk(
    docPath: string,
    overlayRoot: string,
    canonicalRoot: string,
  ): Promise<DocumentSkeleton> {
    const { nodes, overlayExisted, overlayTombstoned } = await buildSkeletonTree(docPath, overlayRoot, canonicalRoot);
    validateNoDuplicateRoots(nodes, docPath);
    const skeleton = new DocumentSkeleton(docPath, nodes, overlayRoot);
    skeleton._overlayPersisted = overlayExisted;
    skeleton._overlayTombstoned = overlayTombstoned;
    return skeleton;
  }

  // --- Protected helpers ---

  protected get skeletonPath(): string {
    return resolveSkeletonPath(this.docPath, this.overlayRoot);
  }

  protected findSiblingList(parentPath: string[]): SkeletonNode[] {
    if (parentPath.length === 0) return this.roots;
    let nodes = this.roots;
    for (const segment of parentPath) {
      const node = nodes.find(n => headingsEqual(n.heading, segment));
      if (!node) {
        throw new Error(
          `Skeleton integrity error: parent "${segment}" not found in ${this.docPath}`
        );
      }
      nodes = node.children;
    }
    return nodes;
  }

  protected resolveSkeletonPathFor(parentPath: string[]): string {
    let skPath = this.skeletonPath;
    let nodes = this.roots;
    for (const segment of parentPath) {
      const node = nodes.find(n => headingsEqual(n.heading, segment));
      if (!node) {
        throw new Error(
          `Skeleton integrity error: parent "${segment}" not found in ${this.docPath}`
        );
      }
      skPath = path.join(`${skPath}.sections`, node.sectionFile);
      nodes = node.children;
    }
    return skPath;
  }

  protected flatten(
    nodes: SkeletonNode[],
    parentPath: string[],
    parentSkeletonPath: string,
  ): FlatEntry[] {
    const result: FlatEntry[] = [];
    const sectionsDir = `${parentSkeletonPath}.sections`;
    for (const node of nodes) {
      const isBfh = node.level === 0 && node.heading === "";
      const hp = isBfh ? [...parentPath] : [...parentPath, node.heading];
      const absPath = path.join(sectionsDir, node.sectionFile);
      result.push({
        headingPath: hp,
        heading: node.heading,
        level: node.level,
        sectionFile: node.sectionFile,
        absolutePath: absPath,
        isSubSkeleton: node.children.length > 0,
      });
      if (node.children.length > 0) {
        result.push(...this.flatten(node.children, hp, absPath));
      }
    }
    return result;
  }

  protected flattenNode(
    node: SkeletonNode,
    parentPath: string[],
    parentSkeletonPath: string,
  ): FlatEntry[] {
    const sectionsDir = `${parentSkeletonPath}.sections`;
    const isBfh = node.level === 0 && node.heading === "";
    const hp = isBfh ? [...parentPath] : [...parentPath, node.heading];
    const absPath = path.join(sectionsDir, node.sectionFile);
    const result: FlatEntry[] = [{
      headingPath: hp,
      heading: node.heading,
      level: node.level,
      sectionFile: node.sectionFile,
      absolutePath: absPath,
      isSubSkeleton: node.children.length > 0,
    }];
    if (node.children.length > 0) {
      result.push(...this.flatten(node.children, hp, absPath));
    }
    return result;
  }

  protected async writeTree(nodes: SkeletonNode[], skeletonPath: string): Promise<void> {
    const content = serializeSkeletonEntries(
      nodes.map(n => ({ heading: n.heading, level: n.level, sectionFile: n.sectionFile })),
    );
    await mkdir(path.dirname(skeletonPath), { recursive: true });
    await writeFile(skeletonPath, content, "utf8");

    // Recurse into children that have their own sub-skeletons
    const sectionsDir = `${skeletonPath}.sections`;
    for (const node of nodes) {
      if (node.children.length > 0) {
        const childSkeletonPath = path.join(sectionsDir, node.sectionFile);
        await this.writeTree(node.children, childSkeletonPath);
      }
    }
  }
}

// ─── DocumentSkeletonInternal ───────────────────────────────────

/**
 * Internal variant of DocumentSkeleton — adds structural mutation methods
 * and persistence. Restricted to OverlayContentLayer internals,
 * recovery-layers.ts crash recovery, and callers that need to modify
 * skeleton structure.
 */
export class DocumentSkeletonInternal extends DocumentSkeleton {

  /**
   * Replace the section at headingPath with one or more new sections.
   *
   * Handles three cases based on the levels of the replacement sections
   * relative to the original:
   *   - Same level, same heading: rename (no-op structurally if only body changed)
   *   - Same level, different heading or multiple at same level: sibling split
   *   - Deeper level: child insertion
   *
   * Always generates fresh sectionFile names. Never reuses.
   *
   * The `added` entries are returned in the same order as `newSections`.
   */
  async replace(
    headingPath: string[],
    newSections: Array<{ heading: string; level: number; body: string }>,
  ): Promise<ReplacementResult> {
    // Before-first-heading section: search this.roots for the level=0, heading="" node
    if (headingPath.length === 0) {
      const idx = this.roots.findIndex(n => n.level === 0 && n.heading === "");
      if (idx < 0) {
        throw new Error(
          `Skeleton integrity error: before-first-heading section not found in ${this.docPath}`
        );
      }
      const oldNode = this.roots[idx];
      const removed = this.flattenNode(oldNode, [], this.skeletonPath);
      // Build replacement nodes from newSections
      const added: FlatEntry[] = [];
      const replacementNodes: SkeletonNode[] = [];
      for (const sec of newSections) {
        const sectionFile = (sec.level === 0 && sec.heading === "")
          ? generateBeforeFirstHeadingFilename()
          : generateSectionFilename(sec.heading);
        const node: SkeletonNode = { heading: sec.heading, level: sec.level, sectionFile, children: [] };
        replacementNodes.push(node);
        const absPath = path.join(`${this.skeletonPath}.sections`, sectionFile);
        added.push({
          headingPath: sec.heading === "" ? [] : [sec.heading],
          heading: sec.heading,
          level: sec.level,
          sectionFile,
          absolutePath: absPath,
          isSubSkeleton: false,
        });
      }
      this.roots.splice(idx, 1, ...replacementNodes);
      await this.persistInternal();
      return { removed, added };
    }

    const parentPath = headingPath.slice(0, -1);
    const oldHeading = headingPath[headingPath.length - 1];
    const siblings = this.findSiblingList(parentPath);
    const idx = siblings.findIndex(n => headingsEqual(n.heading, oldHeading));

    if (idx < 0) {
      throw new Error(
        `Skeleton integrity error: cannot replace "${oldHeading}" — not found ` +
        `under [${parentPath.join(" > ")}] in ${this.docPath}`
      );
    }

    const oldNode = siblings[idx];
    const originalLevel = oldNode.level;

    const removed = this.flattenNode(oldNode, parentPath, this.resolveSkeletonPathFor(parentPath));
    const added: FlatEntry[] = [];

    // Partition new sections: those at original level are siblings,
    // those deeper are children of the first section
    const atLevel: Array<{ heading: string; level: number; body: string }> = [];
    const deeper: Array<{ heading: string; level: number; body: string }> = [];

    for (const sec of newSections) {
      if (sec.level <= originalLevel) {
        atLevel.push(sec);
      } else {
        deeper.push(sec);
      }
    }

    // Build replacement nodes
    const replacementNodes: SkeletonNode[] = [];

    for (let i = 0; i < atLevel.length; i++) {
      const sec = atLevel[i];
      const sectionFile = generateSectionFilename(sec.heading);
      const node: SkeletonNode = {
        heading: sec.heading,
        level: sec.level,
        sectionFile,
        children: [],
      };

      // Attach deeper sections as children of the FIRST sibling-level node
      if (i === 0) {
        for (const child of deeper) {
          const childFile = generateSectionFilename(child.heading);
          node.children.push({
            heading: child.heading,
            level: child.level,
            sectionFile: childFile,
            children: [],
          });
        }
      }

      replacementNodes.push(node);
    }

    // Any node that gained children needs a root child to hold its body,
    // since its file will become a sub-skeleton (overwritten by persist()).
    addBodyHoldersToParents(replacementNodes);

    // Splice into the sibling list
    siblings.splice(idx, 1, ...replacementNodes);

    // Compute added flat entries
    const skeletonPathForParent = this.resolveSkeletonPathFor(parentPath);
    for (const node of replacementNodes) {
      added.push(...this.flattenNode(node, parentPath, skeletonPathForParent));
    }

    await this.persistInternal();
    return { removed, added };
  }

  /**
   * Insert new sections from a before-first-heading fragment split.
   *
   * When the user types heading(s) inside the before-first-heading section, the BFH
   * fragment contains both the preamble body and one or more headed sections.
   * This method adds those headed sections as siblings of the BFH entry in
   * this.roots (NOT as children, to avoid sub-skeleton file conflicts
   * with root's body file).
   *
   * Among themselves, new sections may nest (e.g. ## A followed by ### B
   * makes B a child of A) using the same level-based tree building as
   * buildTreeFromEntries.
   *
   * @returns FlatEntry[] for all added sections (depth-first order,
   *          matching the document-order of newSections).
   */
  async addSectionsFromBeforeFirstHeadingSplit(
    newSections: Array<{ heading: string; level: number; body: string }>,
  ): Promise<FlatEntry[]> {
    const rootIdx = this.roots.findIndex(n => n.level === 0 && n.heading === "");
    if (rootIdx < 0) {
      // No BFH section exists — nothing to split. This is valid for documents
      // that have no content before their first heading.
      return [];
    }

    // Build tree from newSections (level-based nesting among themselves)
    const newNodes: SkeletonNode[] = [];
    const stack: Array<{ level: number; node: SkeletonNode }> = [];

    for (const sec of newSections) {
      while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) {
        stack.pop();
      }

      const sectionFile = generateSectionFilename(sec.heading);
      const node: SkeletonNode = {
        heading: sec.heading,
        level: sec.level,
        sectionFile,
        children: [],
      };

      const parent = stack[stack.length - 1]?.node;
      if (parent) {
        parent.children.push(node);
      } else {
        newNodes.push(node);
      }

      stack.push({ level: sec.level, node });
    }

    // Any node that gained children needs a root child to hold its body,
    // since its file will become a sub-skeleton (overwritten by persist()).
    addBodyHoldersToParents(newNodes);

    // Insert after root in this.roots
    this.roots.splice(rootIdx + 1, 0, ...newNodes);

    // Compute FlatEntries for the added nodes
    const added: FlatEntry[] = [];
    for (const node of newNodes) {
      added.push(...this.flattenNode(node, [], this.skeletonPath));
    }

    await this.persistInternal();
    return added;
  }

  /**
   * Insert a section (with optional body) under a specified parent heading path.
   * If parentPath is empty ([]), the section is added at root level (after root node).
   * Returns FlatEntry[] for the inserted section.
   */
  async insertSectionUnder(
    parentPath: string[],
    section: { heading: string; level: number; body: string },
  ): Promise<FlatEntry[]> {
    const isBfh = section.level === 0 && section.heading === "";
    const sectionFile = isBfh
      ? generateBeforeFirstHeadingFilename()
      : generateSectionFilename(section.heading);
    const node: SkeletonNode = {
      heading: section.heading,
      level: section.level,
      sectionFile,
      children: [],
    };

    const siblings = this.findSiblingList(parentPath);
    siblings.push(node);

    const skeletonPathForParent = this.resolveSkeletonPathFor(parentPath);
    const added = this.flattenNode(node, parentPath, skeletonPathForParent);

    // If the parent now has children and didn't have a root child before,
    // addBodyHoldersToParents will handle it on persist. But we need to
    // ensure the parent node gets root children if it just gained its first child.
    // Also include the new body holder in the returned `added` array so callers
    // write its body file.
    if (parentPath.length > 0) {
      const parentSiblings = this.findSiblingList(parentPath.slice(0, -1));
      const parentNode = parentSiblings.find(
        n => headingsEqual(n.heading, parentPath[parentPath.length - 1]),
      );
      if (parentNode) {
        const hadBodyHolder = parentNode.children.some(c => c.level === 0 && c.heading === "");
        addBodyHoldersToParents([parentNode]);
        if (!hadBodyHolder) {
          const bodyHolder = parentNode.children.find(c => c.level === 0 && c.heading === "");
          if (bodyHolder) {
            const bodyHolderEntries = this.flattenNode(bodyHolder, parentPath, skeletonPathForParent);
            added.push(...bodyHolderEntries);

            // The parent was a leaf — its file held body content. persistInternal()
            // will overwrite it with sub-skeleton markers. Read the body content
            // now and write it to the body holder after persist so it isn't lost.
            const grandparentSkeletonPath = this.resolveSkeletonPathFor(parentPath.slice(0, -1));
            const parentBodyPath = path.join(`${grandparentSkeletonPath}.sections`, parentNode.sectionFile);
            let parentBody = "";
            try {
              parentBody = await readFile(parentBodyPath, "utf8");
            } catch {
              // Parent body file may not exist yet (e.g. just inserted)
            }

            await this.persistInternal();

            if (parentBody) {
              const holderPath = bodyHolderEntries[0].absolutePath;
              await mkdir(path.dirname(holderPath), { recursive: true });
              await writeFile(holderPath, parentBody, "utf8");
            }
            return added;
          }
        }
      }
    }

    await this.persistInternal();
    return added;
  }

  /**
   * Build an overlay DocumentSkeletonInternal from a parsed document.
   *
   * For each section in `parsed`, reuses the canonical section file ID if the
   * heading text (case-insensitive) and parent heading path both match an unconsumed
   * canonical entry. Otherwise mints a fresh file ID.
   *
   * No position-based fallback. A renamed heading always gets a fresh file ID.
   * Two sections that share a heading at different depths are never confused.
   *
   * Persists the overlay skeleton before returning it.
   */
  async buildOverlaySkeleton(
    parsed: { readonly sections: ReadonlyArray<{ headingPath: string[]; heading: string; level: number }> },
    overlayContentRoot: string,
  ): Promise<DocumentSkeletonInternal> {
    // Collect canonical flat entries for matching
    const canonicalFlat: FlatEntry[] = [];
    this.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
      canonicalFlat.push({ headingPath: [...headingPath], heading, level, sectionFile, absolutePath, isSubSkeleton: false });
    });

    const consumed = new Set<number>();
    const nodes: SkeletonNode[] = [];

    for (const section of parsed.sections) {
      const isBfh = section.headingPath.length === 0;
      const heading = section.heading;

      let matchedIdx = -1;
      if (isBfh) {
        // Match the canonical root entry (level=0, heading="")
        for (let ci = 0; ci < canonicalFlat.length; ci++) {
          if (consumed.has(ci)) continue;
          if (canonicalFlat[ci].level === 0 && canonicalFlat[ci].heading === "") {
            matchedIdx = ci;
            break;
          }
        }
      } else {
        // Match by heading text AND parent path — no cross-path ID theft
        const parentPath = section.headingPath.slice(0, -1);
        for (let ci = 0; ci < canonicalFlat.length; ci++) {
          if (consumed.has(ci)) continue;
          const cf = canonicalFlat[ci];
          if (cf.heading.toLowerCase() !== heading.toLowerCase()) continue;
          const cfParent = cf.headingPath.slice(0, -1);
          if (cfParent.length !== parentPath.length) continue;
          if (cfParent.every((seg, i) => headingsEqual(seg, parentPath[i]))) {
            matchedIdx = ci;
            break;
          }
        }
      }

      if (matchedIdx >= 0) consumed.add(matchedIdx);

      const sectionFile = matchedIdx >= 0
        ? canonicalFlat[matchedIdx].sectionFile
        : isBfh ? generateBeforeFirstHeadingFilename() : generateSectionFilename(heading);

      nodes.push({
        heading: isBfh ? "" : heading,
        level: section.level,
        sectionFile,
        children: [],
      });
    }

    const overlay = new DocumentSkeletonInternal(this.docPath, nodes, overlayContentRoot);
    await overlay.persistInternal();
    return overlay;
  }

  // --- Persistence ---

  /** Persist skeleton to the overlay root. Always writes unconditionally. */
  async persistInternal(): Promise<void> {
    await rm(resolveTombstonePath(this.docPath, this.overlayRoot), { force: true });
    await this.writeTree(this.roots, this.skeletonPath);
    this._overlayPersisted = true;
    this._overlayTombstoned = false;
  }

  // --- Static factories ---

  /**
   * Create a tombstone marker file.
   * Persists immediately and returns the internal instance.
   */
  static override async createTombstone(
    docPath: string,
    overlayRoot: string,
  ): Promise<DocumentSkeletonInternal> {
    const skeleton = new DocumentSkeletonInternal(docPath, [], overlayRoot);
    const tombstonePath = resolveTombstonePath(docPath, overlayRoot);
    await mkdir(path.dirname(tombstonePath), { recursive: true });
    await rm(skeleton.skeletonPath, { force: true });
    await rm(`${skeleton.skeletonPath}.sections`, { recursive: true, force: true });
    await writeFile(
      tombstonePath,
      `This file marks file ${normalizeDocPath(docPath)} to be deleted when this proposal is committed\n`,
      "utf8",
    );
    skeleton._overlayPersisted = true;
    skeleton._overlayTombstoned = true;
    return skeleton;
  }

  /**
   * Create an in-memory-only empty skeleton (no disk I/O).
   * Used for new-doc imports where buildOverlaySkeleton handles everything.
   */
  static inMemoryEmpty(
    docPath: string,
    overlayRoot: string,
  ): DocumentSkeletonInternal {
    return new DocumentSkeletonInternal(docPath, [], overlayRoot);
  }

  // --- Static factories ---
  // inMemoryEmpty: creates a live-empty document (zero sections)
  // fromDisk: loads an existing document's skeleton from overlay+canonical
  // fromNodes: builds from pre-assembled nodes (used by crash recovery)
  // createTombstone: creates a deletion marker

  /**
   * Construct a skeleton from pre-assembled nodes. Used by crash recovery to build
   * a compound skeleton from multiple sources without going through fromDisk().
   * targetRoot is used as both overlay and canonical root (recovery writes directly
   * to canonical).
   */
  static fromNodes(
    docPath: string,
    nodes: SkeletonNode[],
    targetRoot: string,
  ): DocumentSkeletonInternal {
    validateNoDuplicateRoots(nodes, docPath);
    return new DocumentSkeletonInternal(docPath, nodes, targetRoot);
  }

  static override async fromDisk(
    docPath: string,
    overlayRoot: string,
    canonicalRoot: string,
  ): Promise<DocumentSkeletonInternal> {
    const { nodes, overlayExisted, overlayTombstoned } = await buildSkeletonTree(docPath, overlayRoot, canonicalRoot);
    validateNoDuplicateRoots(nodes, docPath);
    const skeleton = new DocumentSkeletonInternal(docPath, nodes, overlayRoot);
    skeleton._overlayPersisted = overlayExisted;
    skeleton._overlayTombstoned = overlayTombstoned;
    if (!overlayExisted && nodes.length > 0) {
      await skeleton.persistInternal();
    }
    return skeleton;
  }
}

// ─── Tree construction from disk ─────────────────────────────────

async function buildSkeletonTree(
  docPath: string,
  overlayRoot: string,
  canonicalRoot: string,
): Promise<{ nodes: SkeletonNode[]; overlayExisted: boolean; overlayTombstoned: boolean }> {
  const overlayPath = resolveSkeletonPath(docPath, overlayRoot);
  const canonicalPath = resolveSkeletonPath(docPath, canonicalRoot);

  if (overlayRoot !== canonicalRoot && await fileExists(resolveTombstonePath(docPath, overlayRoot))) {
    return { nodes: [], overlayExisted: true, overlayTombstoned: true };
  }

  // Try overlay first, then canonical
  let skeletonPath: string;
  let overlayExisted = false;
  try {
    await readFile(overlayPath, "utf8");
    skeletonPath = overlayPath;
    overlayExisted = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    try {
      await readFile(canonicalPath, "utf8");
      skeletonPath = canonicalPath;
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code !== "ENOENT") throw err2;
      return { nodes: [], overlayExisted: false, overlayTombstoned: false }; // No skeleton found
    }
  }

  const nodes = await readTreeRecursive(skeletonPath);
  return { nodes, overlayExisted, overlayTombstoned: false };
}

/**
 * Recursively read a skeleton file and discover children from sub-skeleton files.
 *
 * All entries in a single skeleton file are SIBLINGS — nesting is represented
 * by the file system (sub-skeleton files in .sections/ directories), NOT by
 * heading level numbers within a file.
 */
async function readTreeRecursive(skeletonPath: string): Promise<SkeletonNode[]> {
  let content: string;
  try {
    content = await readFile(skeletonPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return []; // File doesn't exist — no entries
  }

  const entries = parseSkeletonToEntries(content);
  if (entries.length === 0) return [];

  const sectionsDir = `${skeletonPath}.sections`;
  const nodes: SkeletonNode[] = [];

  for (const entry of entries) {
    const node: SkeletonNode = {
      heading: entry.heading,
      level: entry.level,
      sectionFile: entry.sectionFile,
      children: [],
    };

    // Children come from sub-skeleton files, NOT from level numbers.
    // A section file that itself contains {{section:}} markers is a sub-skeleton.
    const subSkeletonPath = path.join(sectionsDir, entry.sectionFile);
    node.children = await readTreeRecursive(subSkeletonPath);

    nodes.push(node);
  }

  return nodes;
}

/**
 * Validate that a skeleton has at most one root entry (level=0, heading="")
 * at the top level. Duplicate roots represent an impossible state that causes
 * data loss on re-normalization. Throws immediately rather than letting the
 * corruption cascade.
 */
function validateNoDuplicateRoots(nodes: SkeletonNode[], docPath: string): void {
  const rootCount = nodes.filter(n => n.level === 0 && n.heading === "").length;
  if (rootCount > 1) {
    throw new Error(
      `Skeleton integrity error: ${rootCount} duplicate root entries (level=0, heading="") ` +
      `in ${docPath}. This is an impossible state — only one root is allowed.`,
    );
  }
}

/**
 * Post-process a tree of nodes: any node that has children but no body holder
 * child gets one (level=0, heading="") prepended. This ensures the parent's
 * body content has a file to live in, since the parent's file becomes a
 * sub-skeleton (overwritten by persist/writeTree).
 * These are sub-skeleton body holders, NOT document-level before-first-heading sections.
 */
function addBodyHoldersToParents(nodes: SkeletonNode[]): void {
  for (const node of nodes) {
    if (node.children.length > 0) {
      // Check if a body holder child already exists
      const hasBodyHolder = node.children.some(c => c.level === 0 && c.heading === "");
      if (!hasBodyHolder) {
        const rootFile = generateSectionBodyFilename();
        node.children.unshift({
          heading: "",
          level: 0,
          sectionFile: rootFile,
          children: [],
        });
      }
      // Recurse into children
      addBodyHoldersToParents(node.children);
    }
  }
}
