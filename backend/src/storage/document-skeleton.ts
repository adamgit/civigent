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
 * ## What it owns on disk
 *
 * Skeleton files only — the files containing {{section: filename.md}} markers.
 * persist() and writeSkeletonIfAbsent() write these files. Nothing else.
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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { DocStructureNode } from "../types/shared.js";

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

/**
 * Generate a unique section filename from a heading.
 *
 * INVARIANT: The generated filename stem (without .md) must NEVER equal "__root__",
 * which is the synthetic constant used for root fragment keys. The current format
 * "sec_${slug}_${random}.md" cannot collide with "__root__" by construction.
 */
export function generateSectionFilename(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `sec_${slug}_${randomSuffix}.md`;
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

// ─── DocumentSkeleton ────────────────────────────────────────────

export class DocumentSkeleton {
  readonly docPath: string;
  private roots: SkeletonNode[];
  private _dirty: boolean = false;
  private _overlayPersisted: boolean = false;
  private readonly overlayRoot: string;

  private constructor(
    docPath: string,
    roots: SkeletonNode[],
    overlayRoot: string,
  ) {
    this.docPath = docPath;
    this.roots = roots;
    this.overlayRoot = overlayRoot;
  }

  get dirty(): boolean { return this._dirty; }

  /** True when the overlay contained a skeleton file (vs falling back to canonical). */
  get overlayPersisted(): boolean { return this._overlayPersisted; }

  /** True when the skeleton has no sections at all (no roots). */
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

  private walkNodes(
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
      const isRoot = node.level === 0 && node.heading === "";
      if (!isRoot) hp.push(node.heading);
      const absPath = path.join(sectionsDir, node.sectionFile);
      const isSubSkeleton = node.children.length > 0;
      cb(node.heading, node.level, node.sectionFile, hp, absPath, isSubSkeleton);
      if (isSubSkeleton) {
        this.walkNodes(node.children, hp, absPath, cb);
      }
      if (!isRoot) hp.pop();
    }
  }

  /** Convert tree to DocStructureNode[] for API responses. */
  get structure(): DocStructureNode[] {
    return this.toDocStructureNodes(this.roots);
  }

  private toDocStructureNodes(nodes: SkeletonNode[]): DocStructureNode[] {
    return nodes.map(n => ({
      heading: n.heading,
      level: n.level,
      children: this.toDocStructureNodes(n.children),
    }));
  }

  /**
   * Resolve the root section directly from this.roots — no flat materialization.
   * Returns null if the skeleton is empty (tombstone) or has no root section.
   */
  resolveRoot(): FlatEntry | null {
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
  resolveByFileId(sectionFileId: string): FlatEntry {
    if (sectionFileId === "__root__") {
      const root = this.resolveRoot();
      if (!root) {
        throw new Error(`Skeleton integrity error: no root section in ${this.docPath} (document may be deleted)`);
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

  private walkFindFile(
    nodes: SkeletonNode[],
    parentPath: string[],
    parentSkeletonPath: string,
    targetFile: string,
  ): FlatEntry | null {
    const sectionsDir = `${parentSkeletonPath}.sections`;
    for (const node of nodes) {
      const isRoot = node.level === 0 && node.heading === "";
      const hp = isRoot ? parentPath : [...parentPath, node.heading];
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

  /** Resolve a section by heading path. Throws if not found. */
  resolve(headingPath: string[]): FlatEntry {
    // Root section: headingPath=[]
    if (headingPath.length === 0) {
      const root = this.resolveRoot();
      if (!root) {
        throw new Error(`Skeleton integrity error: no root section in ${this.docPath} (document may be deleted)`);
      }
      return root;
    }

    let nodes = this.roots;
    let currentSkeletonPath = this.skeletonPath;
    const resolvedPath: string[] = [];

    for (let i = 0; i < headingPath.length; i++) {
      const target = headingPath[i];
      const node = nodes.find(n => n.heading.toLowerCase() === target.toLowerCase());
      if (!node) {
        throw new Error(
          `Skeleton integrity error: heading "${target}" not found in ${this.docPath} ` +
          `at path [${resolvedPath.join(" > ")}]. Available: [${nodes.map(n => n.heading).join(", ")}]`
        );
      }
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

    throw new Error(`Skeleton integrity error: empty heading path for ${this.docPath}`);
  }

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
  replace(
    headingPath: string[],
    newSections: Array<{ heading: string; level: number; body: string }>,
  ): ReplacementResult {
    const parentPath = headingPath.slice(0, -1);
    const oldHeading = headingPath[headingPath.length - 1];
    const siblings = this.findSiblingList(parentPath);
    const idx = siblings.findIndex(n => n.heading.toLowerCase() === oldHeading.toLowerCase());

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
    addRootChildrenToParents(replacementNodes);

    // Splice into the sibling list
    siblings.splice(idx, 1, ...replacementNodes);

    // Compute added flat entries
    const skeletonPathForParent = this.resolveSkeletonPathFor(parentPath);
    for (const node of replacementNodes) {
      added.push(...this.flattenNode(node, parentPath, skeletonPathForParent));
    }

    this._dirty = true;

    return { removed, added };
  }

  /**
   * Insert new sections from a root fragment split.
   *
   * When the user types heading(s) inside the root section, the root
   * fragment contains both the root body and one or more headed sections.
   * This method adds those headed sections as siblings of root in
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
  addSectionsFromRootSplit(
    newSections: Array<{ heading: string; level: number; body: string }>,
  ): FlatEntry[] {
    const rootIdx = this.roots.findIndex(n => n.level === 0 && n.heading === "");
    if (rootIdx < 0) {
      throw new Error(`Skeleton integrity error: no root section in ${this.docPath}`);
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
    addRootChildrenToParents(newNodes);

    // Insert after root in this.roots
    this.roots.splice(rootIdx + 1, 0, ...newNodes);

    // Compute FlatEntries for the added nodes
    const added: FlatEntry[] = [];
    for (const node of newNodes) {
      added.push(...this.flattenNode(node, [], this.skeletonPath));
    }

    this._dirty = true;

    return added;
  }

  /**
   * Insert a section (with optional body) under a specified parent heading path.
   * If parentPath is empty ([]), the section is added at root level (after root node).
   * Returns FlatEntry[] for the inserted section.
   */
  insertSectionUnder(
    parentPath: string[],
    section: { heading: string; level: number; body: string },
  ): FlatEntry[] {
    const sectionFile = generateSectionFilename(section.heading);
    const node: SkeletonNode = {
      heading: section.heading,
      level: section.level,
      sectionFile,
      children: [],
    };

    const siblings = this.findSiblingList(parentPath);
    siblings.push(node);

    // If the parent now has children and didn't have a root child before,
    // addRootChildrenToParents will handle it on persist. But we need to
    // ensure the parent node gets root children if it just gained its first child.
    if (parentPath.length > 0) {
      const parentSiblings = this.findSiblingList(parentPath.slice(0, -1));
      const parentNode = parentSiblings.find(
        n => n.heading.toLowerCase() === parentPath[parentPath.length - 1].toLowerCase(),
      );
      if (parentNode) {
        addRootChildrenToParents([parentNode]);
      }
    }

    const skeletonPathForParent = this.resolveSkeletonPathFor(parentPath);
    const added = this.flattenNode(node, parentPath, skeletonPathForParent);

    this._dirty = true;
    return added;
  }

  /**
   * Return FlatEntry[] for the subtree rooted at headingPath (no file I/O).
   * If headingPath is [], returns all content sections (entire document).
   * Sub-skeleton entries are excluded — only body-file entries are returned.
   */
  subtreeEntries(headingPath: string[]): FlatEntry[] {
    if (headingPath.length === 0) {
      const entries: FlatEntry[] = [];
      this.forEachSection((heading, level, sectionFile, hp, absolutePath) => {
        entries.push({ headingPath: [...hp], heading, level, sectionFile, absolutePath, isSubSkeleton: false });
      });
      return entries;
    }
    const parentPath = headingPath.slice(0, -1);
    const target = headingPath[headingPath.length - 1];
    const siblings = this.findSiblingList(parentPath);
    const node = siblings.find(n => n.heading.toLowerCase() === target.toLowerCase());
    if (!node) {
      throw new Error(
        `Skeleton integrity error: heading "${target}" not found in ${this.docPath} ` +
        `at path [${parentPath.join(" > ")}]`
      );
    }
    return this.flattenNode(node, parentPath, this.resolveSkeletonPathFor(parentPath))
      .filter(e => !e.isSubSkeleton);
  }

  /** Write the skeleton to the overlay. Throws if not dirty. */
  async persist(): Promise<void> {
    if (!this._dirty) {
      throw new Error(`Skeleton persist called but not dirty for ${this.docPath}`);
    }
    await this.writeTree(this.roots, this.skeletonPath);
    this._dirty = false;
    this._overlayPersisted = true;
  }

  /**
   * Ensure the overlay skeleton file exists on disk.
   *
   * When body files are written to the overlay (e.g. during flush), the
   * overlay skeleton must also exist so that readers (resolveAllSectionPaths,
   * readAllSectionsWithOverlay) can discover those body files. Without this,
   * simple body edits (no structural change) would write orphaned body files
   * that no skeleton points to.
   *
   * This is idempotent — if the overlay was already persisted (either by
   * persist() or a previous writeSkeletonIfAbsent() call), this is a no-op.
   */
  async writeSkeletonIfAbsent(): Promise<void> {
    if (this._overlayPersisted) return;
    await this.writeTree(this.roots, this.skeletonPath);
    this._overlayPersisted = true;
  }

  /**
   * Build an overlay DocumentSkeleton from a parsed document.
   *
   * For each section in `parsed`, reuses the canonical section file ID if the
   * heading text (case-insensitive) and parent heading path both match an unconsumed
   * canonical entry. Otherwise mints a fresh file ID.
   *
   * No position-based fallback. A renamed heading always gets a fresh file ID.
   * Two sections that share a heading at different depths are never confused.
   *
   * Pure transformation — no I/O. Call overlay.persist() to write to disk.
   */
  buildOverlaySkeleton(
    parsed: { readonly sections: ReadonlyArray<{ headingPath: string[]; heading: string; level: number }> },
    overlayContentRoot: string,
  ): DocumentSkeleton {
    // Collect canonical flat entries for matching
    const canonicalFlat: FlatEntry[] = [];
    this.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
      canonicalFlat.push({ headingPath: [...headingPath], heading, level, sectionFile, absolutePath, isSubSkeleton: false });
    });

    const consumed = new Set<number>();
    const nodes: SkeletonNode[] = [];

    for (const section of parsed.sections) {
      const isRoot = section.headingPath.length === 0;
      const heading = section.heading;

      let matchedIdx = -1;
      if (isRoot) {
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
          if (cfParent.every((seg, i) => seg.toLowerCase() === parentPath[i].toLowerCase())) {
            matchedIdx = ci;
            break;
          }
        }
      }

      if (matchedIdx >= 0) consumed.add(matchedIdx);

      const sectionFile = matchedIdx >= 0
        ? canonicalFlat[matchedIdx].sectionFile
        : generateSectionFilename(isRoot ? "root" : heading);

      nodes.push({
        heading: isRoot ? "" : heading,
        level: section.level,
        sectionFile,
        children: [],
      });
    }

    const overlay = new DocumentSkeleton(this.docPath, nodes, overlayContentRoot);
    overlay._dirty = true;
    return overlay;
  }

  // --- Construction ---

  /**
   * Create a tombstone skeleton — an empty skeleton (zero entries) at the given
   * doc path in the overlay root. When promoted to canonical, an empty skeleton
   * signals "delete this document": all canonical files are removed.
   *
   * Call persist() to write the empty skeleton file to the overlay.
   */
  static createTombstone(
    docPath: string,
    overlayRoot: string,
  ): DocumentSkeleton {
    const skeleton = new DocumentSkeleton(docPath, [], overlayRoot);
    skeleton._dirty = true;
    return skeleton;
  }

  /**
   * Derive the sections directory path for a given document.
   * This is where all body files and sub-skeletons live on disk.
   */
  static sectionsDir(docPath: string, contentRoot: string): string {
    const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
    return path.resolve(contentRoot, ...normalized.split("/")) + ".sections";
  }

  /**
   * Create an empty skeleton for a new document.
   * Uses targetRoot as both overlay and canonical root (writing directly to canonical).
   * Call persist() to write the skeleton file to disk.
   */
  static createEmpty(
    docPath: string,
    targetRoot: string,
  ): DocumentSkeleton {
    const rootNode: SkeletonNode = {
      heading: "",
      level: 0,
      sectionFile: generateSectionFilename("root"),
      children: [],
    };
    const skeleton = new DocumentSkeleton(docPath, [rootNode], targetRoot);
    skeleton._dirty = true;
    return skeleton;
  }

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
  ): DocumentSkeleton {
    validateNoDuplicateRoots(nodes, docPath);
    return new DocumentSkeleton(docPath, nodes, targetRoot);
  }

  static async fromDisk(
    docPath: string,
    overlayRoot: string,
    canonicalRoot: string,
  ): Promise<DocumentSkeleton> {
    const { nodes, overlayExisted } = await buildSkeletonTree(docPath, overlayRoot, canonicalRoot);
    validateNoDuplicateRoots(nodes, docPath);
    const skeleton = new DocumentSkeleton(docPath, nodes, overlayRoot);
    skeleton._overlayPersisted = overlayExisted;
    return skeleton;
  }

  // --- Private helpers ---

  private get skeletonPath(): string {
    const normalized = this.docPath.replace(/\\/g, "/").replace(/^\/+/, "");
    return path.resolve(this.overlayRoot, ...normalized.split("/"));
  }

  private findSiblingList(parentPath: string[]): SkeletonNode[] {
    if (parentPath.length === 0) return this.roots;
    let nodes = this.roots;
    for (const segment of parentPath) {
      const node = nodes.find(n => n.heading.toLowerCase() === segment.toLowerCase());
      if (!node) {
        throw new Error(
          `Skeleton integrity error: parent "${segment}" not found in ${this.docPath}`
        );
      }
      nodes = node.children;
    }
    return nodes;
  }

  private resolveSkeletonPathFor(parentPath: string[]): string {
    let skPath = this.skeletonPath;
    let nodes = this.roots;
    for (const segment of parentPath) {
      const node = nodes.find(n => n.heading.toLowerCase() === segment.toLowerCase());
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

  private flatten(
    nodes: SkeletonNode[],
    parentPath: string[],
    parentSkeletonPath: string,
  ): FlatEntry[] {
    const result: FlatEntry[] = [];
    const sectionsDir = `${parentSkeletonPath}.sections`;
    for (const node of nodes) {
      const isRoot = node.level === 0 && node.heading === "";
      const hp = isRoot ? [...parentPath] : [...parentPath, node.heading];
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

  private flattenNode(
    node: SkeletonNode,
    parentPath: string[],
    parentSkeletonPath: string,
  ): FlatEntry[] {
    const sectionsDir = `${parentSkeletonPath}.sections`;
    const isRoot = node.level === 0 && node.heading === "";
    const hp = isRoot ? [...parentPath] : [...parentPath, node.heading];
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

  private async writeTree(nodes: SkeletonNode[], skeletonPath: string): Promise<void> {
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

// ─── Tree construction from disk ─────────────────────────────────

async function buildSkeletonTree(
  docPath: string,
  overlayRoot: string,
  canonicalRoot: string,
): Promise<{ nodes: SkeletonNode[]; overlayExisted: boolean }> {
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const overlayPath = path.resolve(overlayRoot, ...normalized.split("/"));
  const canonicalPath = path.resolve(canonicalRoot, ...normalized.split("/"));

  // Try overlay first, then canonical
  let skeletonPath: string;
  let overlayExisted = false;
  let overlayContent: string | null = null;
  try {
    overlayContent = await readFile(overlayPath, "utf8");
    skeletonPath = overlayPath;
    overlayExisted = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    try {
      await readFile(canonicalPath, "utf8");
      skeletonPath = canonicalPath;
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code !== "ENOENT") throw err2;
      return { nodes: [], overlayExisted: false }; // No skeleton found
    }
  }

  let nodes = await readTreeRecursive(skeletonPath);

  // If the overlay exists but is empty, fall through to canonical.
  //
  // Empty overlay skeletons arise from stale/corrupt session state (e.g. a
  // session that flushed before any content existed, or was abandoned mid-flight).
  // They must NOT shadow a non-empty canonical skeleton — doing so makes the
  // document appear empty to every reader.
  //
  // Intentional tombstones (document-deletion proposals) are processed exclusively
  // in CanonicalStore.absorb().deletionPass, which reads skeletons directly via
  // parseSkeletonToEntries and never calls DocumentSkeleton.fromDisk.  Therefore
  // treating an empty overlay as "absent" here is safe for all current call sites.
  if (overlayExisted && nodes.length === 0) {
    const fallbackNodes = await readTreeRecursive(canonicalPath);
    if (fallbackNodes.length > 0) {
      return { nodes: fallbackNodes, overlayExisted: false };
    }
  }

  return { nodes, overlayExisted };
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
 * Post-process a tree of nodes: any node that has children but no root child
 * gets a root child (level=0, heading="") prepended. This ensures the parent's
 * body content has a file to live in, since the parent's file becomes a
 * sub-skeleton (overwritten by persist/writeTree).
 */
function addRootChildrenToParents(nodes: SkeletonNode[]): void {
  for (const node of nodes) {
    if (node.children.length > 0) {
      // Check if a root child already exists
      const hasRoot = node.children.some(c => c.level === 0 && c.heading === "");
      if (!hasRoot) {
        const rootFile = generateSectionFilename("root");
        node.children.unshift({
          heading: "",
          level: 0,
          sectionFile: rootFile,
          children: [],
        });
      }
      // Recurse into children (skip the root child itself)
      addRootChildrenToParents(node.children);
    }
  }
}
