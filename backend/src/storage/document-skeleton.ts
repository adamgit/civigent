/**
 * DocumentSkeleton — In-memory model of a document's heading tree.
 *
 * Owns the tree structure (headings, levels, section filenames, nesting).
 * Provides:
 *   - flat: ordered view of all sections (derived from tree)
 *   - resolve(headingPath): lookup a section by heading path
 *   - replace(headingPath, newSections): structural mutation (split/rename)
 *   - persist(): write skeleton to overlay
 *   - fromDisk(): construct from overlay + canonical fallback
 *
 * Does NOT store body content — that's in section files on disk
 * and in Y.Doc fragments in memory.
 */

import path from "node:path";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
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

export interface SubtreeEntry {
  headingPath: string[];
  heading: string;
  level: number;
  bodyContent: string;
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
  private readonly canonicalRoot: string;

  private constructor(
    docPath: string,
    roots: SkeletonNode[],
    overlayRoot: string,
    canonicalRoot: string,
  ) {
    this.docPath = docPath;
    this.roots = roots;
    this.overlayRoot = overlayRoot;
    this.canonicalRoot = canonicalRoot;
  }

  get dirty(): boolean { return this._dirty; }

  /** True when the overlay contained a skeleton file (vs falling back to canonical). */
  get overlayPersisted(): boolean { return this._overlayPersisted; }

  /** True when the skeleton has no sections at all (no roots). */
  get isEmpty(): boolean { return this.roots.length === 0; }

  /** Flat ordered view of all sections. Recomputed from tree on each call. */
  get flat(): FlatEntry[] {
    return this.flatten(this.roots, [], this.skeletonPath);
  }

  /**
   * Depth-first visitor over all sections. Zero intermediate allocation.
   *
   * headingPath is a shared mutable array — push/pop during walk.
   * Callers must copy it (e.g. [...headingPath]) if they retain it.
   */
  forEachSection(
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
    return {
      headingPath: [],
      heading: rootNode.heading,
      level: rootNode.level,
      sectionFile: rootNode.sectionFile,
      absolutePath: path.join(sectionsDir, rootNode.sectionFile),
      isSubSkeleton: rootNode.children.length > 0,
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
        return {
          headingPath: [...resolvedPath],
          heading: node.heading,
          level: node.level,
          sectionFile: node.sectionFile,
          absolutePath: absPath,
          isSubSkeleton: node.children.length > 0,
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
   * Collect the full subtree rooted at headingPath: the section itself and all
   * descendants. Reads body files from disk for each node (skips sub-skeleton
   * entries whose content is structural, not body text).
   *
   * Used by the move endpoint to capture everything before removal.
   */
  async collectSubtree(headingPath: string[]): Promise<SubtreeEntry[]> {
    // Collect body entries (sync walk), then read files (async)
    const bodyEntries: Array<{ headingPath: string[]; heading: string; level: number; absolutePath: string }> = [];

    if (headingPath.length === 0) {
      this.forEachSection((heading, level, _sf, hp, absolutePath, isSubSkeleton) => {
        if (!isSubSkeleton) bodyEntries.push({ headingPath: [...hp], heading, level, absolutePath });
      });
    } else {
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
      for (const entry of this.flattenNode(node, parentPath, this.resolveSkeletonPathFor(parentPath))) {
        if (!entry.isSubSkeleton) bodyEntries.push(entry);
      }
    }

    const result: SubtreeEntry[] = [];
    for (const { headingPath: hp, heading, level, absolutePath } of bodyEntries) {
      let bodyContent = "";
      try {
        bodyContent = await readFile(absolutePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      result.push({ headingPath: hp, heading, level, bodyContent });
    }
    return result;
  }

  /**
   * Copy ALL skeleton files (main + sub-skeletons) from overlay to canonical.
   * Also deletes orphaned section files that are no longer referenced by the
   * new skeleton (e.g. after section splits, renames, or deletions).
   *
   * Uses writeTree() which recursively writes sub-skeleton files for any
   * node with children, so this handles arbitrarily nested structures.
   */
  async promoteOverlay(): Promise<void> {
    const normalized = this.docPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const canonicalSkeletonPath = path.resolve(this.canonicalRoot, ...normalized.split("/"));

    // 1. Read current canonical skeleton to find old section files
    const oldSectionFiles = new Set<string>();
    const oldSubSkeletonDirs = new Set<string>();
    try {
      const oldSkeleton = await DocumentSkeleton.fromDisk(
        this.docPath, this.canonicalRoot, this.canonicalRoot,
      );
      oldSkeleton.forEachSection((_h, _l, _sf, _hp, absolutePath, isSubSkeleton) => {
        oldSectionFiles.add(absolutePath);
        if (isSubSkeleton) oldSubSkeletonDirs.add(absolutePath);
      });
    } catch {
      // No existing canonical skeleton — nothing to clean up
    }

    // Tombstone: empty skeleton means "delete this document from canonical"
    if (this.isEmpty) {
      // Delete canonical skeleton file
      try {
        await rm(canonicalSkeletonPath, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // Delete canonical .sections/ directory
      try {
        await rm(`${canonicalSkeletonPath}.sections`, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // Delete all old section body files
      for (const oldFile of oldSectionFiles) {
        try { await rm(oldFile, { force: true }); } catch { /* ignore ENOENT */ }
      }
      for (const oldDir of oldSubSkeletonDirs) {
        try { await rm(oldDir + ".sections", { recursive: true, force: true }); } catch { /* ignore */ }
      }
      return;
    }

    // 2. Write new skeleton to canonical
    await this.writeTree(this.roots, canonicalSkeletonPath);

    // 3. Compute new section files
    const newSkeleton = await DocumentSkeleton.fromDisk(
      this.docPath, this.canonicalRoot, this.canonicalRoot,
    );
    const newSectionFiles = new Set<string>();
    const newSubSkeletonDirs = new Set<string>();
    newSkeleton.forEachSection((_h, _l, _sf, _hp, absolutePath, isSubSkeleton) => {
      newSectionFiles.add(absolutePath);
      if (isSubSkeleton) newSubSkeletonDirs.add(absolutePath);
    });

    // 4. Delete orphaned section body files (old entries not in new skeleton)
    for (const oldFile of oldSectionFiles) {
      if (!newSectionFiles.has(oldFile) && !oldSubSkeletonDirs.has(oldFile)) {
        try {
          await rm(oldFile, { force: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }

    // 5. Delete orphaned sub-skeleton directories
    for (const oldDir of oldSubSkeletonDirs) {
      if (!newSubSkeletonDirs.has(oldDir)) {
        try {
          await rm(oldDir + ".sections", { recursive: true, force: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }
  }

  /** Write the skeleton to the overlay. Throws if not dirty. */
  async persist(): Promise<void> {
    if (!this._dirty) {
      throw new Error(`Skeleton persist called but not dirty for ${this.docPath}`);
    }
    await this.writeTree(this.roots, this.overlaySkeletonPath);
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
   * persist() or a previous ensureOverlayExists() call), this is a no-op.
   */
  async ensureOverlayExists(): Promise<void> {
    if (this._overlayPersisted) return;
    await this.writeTree(this.roots, this.overlaySkeletonPath);
    this._overlayPersisted = true;
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
    canonicalRoot?: string,
  ): DocumentSkeleton {
    const skeleton = new DocumentSkeleton(
      docPath, [], overlayRoot, canonicalRoot ?? overlayRoot,
    );
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
    const skeleton = new DocumentSkeleton(docPath, [rootNode], targetRoot, targetRoot);
    skeleton._dirty = true;
    return skeleton;
  }

  static async fromDisk(
    docPath: string,
    overlayRoot: string,
    canonicalRoot: string,
  ): Promise<DocumentSkeleton> {
    const { nodes, overlayExisted } = await buildSkeletonTree(docPath, overlayRoot, canonicalRoot);
    const skeleton = new DocumentSkeleton(docPath, nodes, overlayRoot, canonicalRoot);
    skeleton._overlayPersisted = overlayExisted;
    return skeleton;
  }

  // --- Private helpers ---

  private get skeletonPath(): string {
    const normalized = this.docPath.replace(/\\/g, "/").replace(/^\/+/, "");
    return path.resolve(this.overlayRoot, ...normalized.split("/"));
  }

  private get overlaySkeletonPath(): string {
    return this.skeletonPath;
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
      return { nodes: [], overlayExisted: false }; // No skeleton found
    }
  }

  const nodes = await readTreeRecursive(skeletonPath);
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
