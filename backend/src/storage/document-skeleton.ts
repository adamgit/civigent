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
import { access, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import type { DocStructureNode } from "../types/shared.js";
import { normalizeDocPath } from "./path-utils.js";
import { staleHeadingPath } from "./skeleton-errors.js";

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

export interface ContentEntry {
  kind: "content_entry";
  headingPath: string[];
  heading: string;
  level: number;
  sectionFile: string;
  absolutePath: string;
  storageRole: "direct_section" | "body_holder" | "before_first_heading";
}

export interface StructuralNodeEntry {
  kind: "structural_node";
  headingPath: string[];
  heading: string;
  level: number;
  sectionFile: string;
  absolutePath: string;
  hasChildren: boolean;
}


export interface ReplacementResult {
  /** Entries removed from the flat list */
  removed: FlatEntry[];
  /** Entries added to the flat list (in order, matching input newSections order) */
  added: FlatEntry[];
}

export interface CollapseParentResult {
  /** Entries removed from the skeleton (target sub-skeleton entry + body holder only). */
  removed: FlatEntry[];
  /** The merge target — where the orphan body should be absorbed. */
  mergeTarget: FlatEntry;
  /** Whether the merge target was auto-created (BFH fabrication). */
  mergeTargetWasCreated: boolean;
  /** The target's body-holder entry (OLD position) — carries the orphan body content.
   *  Null when the target had no body-holder child. */
  bodyHolderEntry: FlatEntry | null;
  /** Promoted children entries in their OLD positions (for pre-reading bodies). */
  oldPromotedEntries: FlatEntry[];
  /** Promoted children entries in their NEW positions (for writing bodies). */
  promotedEntries: FlatEntry[];
  /** Body file writes the caller must perform (e.g. empty BFH body). */
  bodyWrites: Array<{ absolutePath: string; content: string }>;
  /** Fragment key remaps (from → null for deleted keys). */
  fragmentKeyRemaps: Array<{ from: string; to: string | null }>;
}

// ─── DocumentSkeleton (readonly) ────────────────────────────────

export class DocumentSkeleton {
  readonly docPath: string;
  protected roots: SkeletonNode[];

  // ── Three independent provenance/state concepts (do NOT collapse) ──
  //
  // 1. loadedFromOverlay: the structural nodes currently held in this
  //    instance were read from the overlay skeleton file (not the
  //    canonical fallback). True for any DocumentSkeleton constructed
  //    via fromDisk that found and parsed an overlay skeleton file.
  //
  // 2. overlaySkeletonFileExisted: at the moment fromDisk was called,
  //    SOME overlay marker existed for this docPath — either a live
  //    skeleton file or a tombstone. This is a strict superset of
  //    loadedFromOverlay (a tombstone makes file-existed true even
  //    though no nodes loaded).
  //
  // 3. hasBeenWrittenToOverlay: this specific in-memory instance has
  //    successfully persisted its state to the overlay since being
  //    constructed (via flushToOverlay or by being created via a
  //    factory that auto-persists). It is allowed for a freshly-loaded
  //    readonly DocumentSkeleton to have all three false-true-false
  //    independently of each other.
  //
  // Item 137 explicitly forbids collapsing these into one property.
  protected _loadedFromOverlay: boolean = false;
  protected _overlaySkeletonFileExisted: boolean = false;
  protected _hasBeenWrittenToOverlay: boolean = false;

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

  /**
   * True when this instance's structural nodes were resolved from the
   * overlay skeleton file rather than from the canonical fallback.
   */
  get loadedFromOverlay(): boolean { return this._loadedFromOverlay; }

  /**
   * True when an overlay file (live skeleton OR tombstone) existed at the
   * moment of load. Strict superset of loadedFromOverlay.
   */
  get overlaySkeletonFileExisted(): boolean { return this._overlaySkeletonFileExisted; }

  /**
   * True when this in-memory instance has persisted its state to the
   * overlay since being constructed.
   */
  get hasBeenWrittenToOverlay(): boolean { return this._hasBeenWrittenToOverlay; }

  /** True when the overlay contains a tombstone marker for this document. */
  get isTombstonedInOverlay(): boolean { return this._overlayTombstoned; }

  /** True when the loaded skeleton tree has zero section entries. */
  get areSkeletonRootsEmpty(): boolean { return this.roots.length === 0; }

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

  protected makeStructuralNodeEntry(
    node: SkeletonNode,
    parentPath: string[],
    parentSkeletonPath: string,
  ): StructuralNodeEntry {
    const isBfh = node.level === 0 && node.heading === "";
    const headingPath = isBfh ? [...parentPath] : [...parentPath, node.heading];
    const absolutePath = path.join(`${parentSkeletonPath}.sections`, node.sectionFile);
    return {
      kind: "structural_node",
      headingPath,
      heading: node.heading,
      level: node.level,
      sectionFile: node.sectionFile,
      absolutePath,
      hasChildren: node.children.length > 0,
    };
  }

  protected makeContentEntry(
    structuralNode: StructuralNodeEntry,
    bodyHolderSectionFile?: string,
  ): ContentEntry {
    if (bodyHolderSectionFile) {
      return {
        kind: "content_entry",
        headingPath: [...structuralNode.headingPath],
        heading: structuralNode.heading,
        level: structuralNode.level,
        sectionFile: bodyHolderSectionFile,
        absolutePath: path.join(`${structuralNode.absolutePath}.sections`, bodyHolderSectionFile),
        storageRole: structuralNode.headingPath.length === 0 ? "before_first_heading" : "body_holder",
      };
    }
    return {
      kind: "content_entry",
      headingPath: [...structuralNode.headingPath],
      heading: structuralNode.heading,
      level: structuralNode.level,
      sectionFile: structuralNode.sectionFile,
      absolutePath: structuralNode.absolutePath,
      storageRole: structuralNode.headingPath.length === 0 ? "before_first_heading" : "direct_section",
    };
  }

  /**
   * Resolve the before-first-heading content entry directly from this.roots — no flat materialization.
   * Returns null if the skeleton is empty (tombstone) or has no before-first-heading section.
   */
  protected findBeforeFirstHeadingContentEntry(): ContentEntry | null {
    const rootNode = this.roots.find(n => n.level === 0 && n.heading === "");
    if (!rootNode) {
      return null;
    }
    const structuralNode = this.makeStructuralNodeEntry(rootNode, [], this.skeletonPath);
    const bodyHolder = rootNode.children.find(c => c.level === 0 && c.heading === "");
    return this.makeContentEntry(structuralNode, bodyHolder?.sectionFile);
  }

  /**
   * Resolve the before-first-heading structural node directly from this.roots.
   * Returns null if the skeleton is empty (tombstone) or has no BFH node.
   */
  protected findBeforeFirstHeadingStructuralNode(): StructuralNodeEntry | null {
    const rootNode = this.roots.find(n => n.level === 0 && n.heading === "");
    return rootNode ? this.makeStructuralNodeEntry(rootNode, [], this.skeletonPath) : null;
  }

  /**
   * Resolve a section by its section file ID (filename stem, e.g. "sec_abc123def").
   * Uses a recursive tree walk with early return — no flat materialization.
   * Throws if not found.
   */
  requireEntryBySectionFileId(sectionFileId: string): FlatEntry {
    if (sectionFileId === "__beforeFirstHeading__") {
      const root = this.findBeforeFirstHeadingContentEntry();
      if (!root) {
        throw new Error(`No before-first-heading section in ${this.docPath}. The document may have no content before its first heading.`);
      }
      return {
        headingPath: root.headingPath,
        heading: root.heading,
        level: root.level,
        sectionFile: root.sectionFile,
        absolutePath: root.absolutePath,
        isSubSkeleton: false,
      };
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
   * Returns null if not found (no throw). Prefer this over requireEntryBySectionFileId when
   * callers need find-or-null semantics.
   */
  findEntryBySectionFileId(sectionFileId: string): FlatEntry | null {
    if (sectionFileId === "__beforeFirstHeading__") {
      const root = this.findBeforeFirstHeadingContentEntry();
      return root ? {
        headingPath: root.headingPath,
        heading: root.heading,
        level: root.level,
        sectionFile: root.sectionFile,
        absolutePath: root.absolutePath,
        isSubSkeleton: false,
      } : null;
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

  /** Look up a content entry by heading path. Returns null if not found. */
  findContentEntryByHeadingPath(headingPath: string[]): ContentEntry | null {
    if (headingPath.length === 0) {
      return this.findBeforeFirstHeadingContentEntry();
    }

    const structuralNode = this.findStructuralNodeByHeadingPath(headingPath);
    if (!structuralNode) return null;

    let nodes = this.roots;
    for (let i = 0; i < headingPath.length; i++) {
      const target = headingPath[i];
      const node = nodes.find(n => headingsEqual(n.heading, target));
      if (!node) return null;
      if (i === headingPath.length - 1) {
        const bodyHolder = node.children.find(c => c.level === 0 && c.heading === "");
        return this.makeContentEntry(structuralNode, bodyHolder?.sectionFile);
      }
      nodes = node.children;
    }
    return this.makeContentEntry(structuralNode);
  }

  /** Resolve a content entry by heading path. Throws if not found. */
  requireContentEntryByHeadingPath(headingPath: string[]): ContentEntry {
    const entry = this.findContentEntryByHeadingPath(headingPath);
    if (!entry) {
      if (headingPath.length === 0) {
        throw new Error(`No before-first-heading section in ${this.docPath}. The document may have no content before its first heading.`);
      }
      throw new Error(
        `Skeleton integrity error: content entry for heading path [${headingPath.join(" > ")}] not found in ${this.docPath}`
      );
    }
    return entry;
  }

  /** Look up a structural node by heading path. Returns null if not found. */
  findStructuralNodeByHeadingPath(headingPath: string[]): StructuralNodeEntry | null {
    if (headingPath.length === 0) {
      return this.findBeforeFirstHeadingStructuralNode();
    }

    let nodes = this.roots;
    let currentSkeletonPath = this.skeletonPath;
    const resolvedPath: string[] = [];

    for (let i = 0; i < headingPath.length; i++) {
      const target = headingPath[i];
      const node = nodes.find(n => headingsEqual(n.heading, target));
      if (!node) return null;
      resolvedPath.push(node.heading);

      if (i === headingPath.length - 1) {
        return this.makeStructuralNodeEntry(node, resolvedPath.slice(0, -1), currentSkeletonPath);
      }

      currentSkeletonPath = path.join(`${currentSkeletonPath}.sections`, node.sectionFile);
      nodes = node.children;
    }

    return null;
  }

  /** Resolve a structural node by heading path. Throws if not found. */
  requireStructuralNodeByHeadingPath(headingPath: string[]): StructuralNodeEntry {
    const node = this.findStructuralNodeByHeadingPath(headingPath);
    if (!node) {
      if (headingPath.length === 0) {
        throw new Error(`No before-first-heading section in ${this.docPath}. The document may have no content before its first heading.`);
      }
      throw new Error(
        `Skeleton integrity error: structural node for heading path [${headingPath.join(" > ")}] not found in ${this.docPath}`
      );
    }
    return node;
  }

  /** Check whether a heading path exists in the skeleton. */
  has(headingPath: string[]): boolean {
    return this.findStructuralNodeByHeadingPath(headingPath) !== null;
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
   * Return ALL structural entries — both content sections AND sub-skeleton
   * body-holder/parent nodes — in document order.
   *
   * This is the structural-layer counterpart of allContentEntries(). Callers
   * that currently rebuild the same result by running forEachNode(...) with
   * their own accumulator should prefer this helper so the allocation and
   * headingPath copying are consolidated in one place.
   *
   * Used by recovery, persistence inspection, and anything that needs to
   * reason about the skeleton tree as a whole rather than just its
   * content-facing slice.
   */
  allStructuralEntries(): FlatEntry[] {
    const entries: FlatEntry[] = [];
    this.forEachNode((heading, level, sectionFile, hp, absolutePath, isSubSkeleton) => {
      entries.push({
        headingPath: [...hp],
        heading,
        level,
        sectionFile,
        absolutePath,
        isSubSkeleton,
      });
    });
    return entries;
  }

  /**
   * Serialize the full structural tree as a flat SkeletonEntry[] preserving
   * document order. Unlike allStructuralEntries() this strips the runtime
   * (absolutePath / isSubSkeleton / headingPath) fields, producing the exact
   * shape that parseSkeletonToEntries()/serializeSkeletonEntries() operate on.
   *
   * Crash recovery previously rebuilt this by hand from forEachNode; pulling
   * the construction into one method removes that duplication and guarantees
   * callers get the same traversal order as the on-disk writer.
   *
   * NOTE: this is a flat snapshot across the entire (possibly nested) tree.
   * It is NOT a round-trip of the on-disk sub-skeleton file layout — those
   * files live in separate directories. Use this for payloads that need a
   * single linear list of structural entries.
   */
  serializeStructuralEntries(): SkeletonEntry[] {
    const out: SkeletonEntry[] = [];
    this.forEachNode((heading, level, sectionFile) => {
      out.push({ heading, level, sectionFile });
    });
    return out;
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

  // NOTE per checklist item 93: createTombstone has been removed from
  // readonly DocumentSkeleton. Tombstone creation is a mutating disk
  // operation and now lives behind ContentLayer. The previous implementation
  // (which silently auto-persisted) violated the readonly contract of this
  // class.

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
    skeleton._loadedFromOverlay = overlayExisted && !overlayTombstoned;
    skeleton._overlaySkeletonFileExisted = overlayExisted;
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

  /**
   * Write a skeleton file and recurse into sub-skeletons.
   *
   * When inside a sub-skeleton (isSubSkeleton=true), body holder entries
   * (level=0, heading="") get an empty body file created if one doesn't
   * already exist on disk. This prevents dangling references: writeTree
   * overwrites the parent section's body file with sub-skeleton markers,
   * so the body holder file that replaces it must exist. Callers like
   * insertSectionUnder write the body file themselves, in which case
   * the existence check makes this a no-op.
   *
   * This intentionally crosses the "skeleton writes skeleton files,
   * body writes happen through ContentLayer" boundary for this one case —
   * it's the single place where the skeleton layer creates a structural
   * dependency that requires a body file to exist.
   */
  protected async writeTree(
    nodes: SkeletonNode[],
    skeletonPath: string,
    isSubSkeleton = false,
  ): Promise<void> {
    const content = serializeSkeletonEntries(
      nodes.map(n => ({ heading: n.heading, level: n.level, sectionFile: n.sectionFile })),
    );
    await mkdir(path.dirname(skeletonPath), { recursive: true });
    await writeFile(skeletonPath, content, "utf8");

    const sectionsDir = `${skeletonPath}.sections`;

    // Ensure body holder files exist inside sub-skeletons
    if (isSubSkeleton) {
      for (const node of nodes) {
        if (node.level === 0 && node.heading === "") {
          const bodyFilePath = path.join(sectionsDir, node.sectionFile);
          const exists = await access(bodyFilePath).then(() => true, () => false);
          if (!exists) {
            await mkdir(sectionsDir, { recursive: true });
            await writeFile(bodyFilePath, "", "utf8");
          }
        }
      }
    }

    // Recurse into children that have their own sub-skeletons
    for (const node of nodes) {
      if (node.children.length > 0) {
        const childSkeletonPath = path.join(sectionsDir, node.sectionFile);
        await this.writeTree(node.children, childSkeletonPath, true);
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

  // NOTE per checklist items 97/99/101/109: the following caller-facing
  // primitives have been deleted from this class:
  //
  //   - replace(headingPath, newSections)            [item 97]
  //   - addSectionsFromBeforeFirstHeadingSplit(...)  [item 99]
  //   - insertSectionUnder(parentPath, section)      [item 101]
  //   - buildOverlaySkeleton(parsed, overlayRoot)    [item 109]
  //
  // These were structurally overloaded (one primitive papered over delete,
  // rename, sibling-split, child-insert) and forced callers to know about
  // BFH/root-position mechanics. Their replacements live behind explicit
  // ContentLayer / StagedSectionsStore operations. Compile errors at the old call
  // sites are EXPECTED — the callers will be reworked in a follow-up pass
  // through the OverlayContentLayer / store migration items in this checklist.

  // --- Document-order navigation helpers ----------------------------

  /**
   * Walk forEachSection in document order and return the last
   * body-holding section emitted strictly BEFORE the section identified
   * by `targetSectionFile`. Returns null if `targetSectionFile` is the
   * very first body-holder in the document. Throws if `targetSectionFile`
   * is not present in the skeleton at all (corrupted skeleton or stale
   * caller-provided id).
   *
   * Used by item 145 `deleteHeadingPreservingBody` to locate the orphan
   * absorption target, and by item 369 `rewriteSubtreeFromParsedMarkdown`
   * to locate the merge target for `leadingOrphanBody` absorption.
   *
   * Snapshot semantics — the returned FlatEntry is captured before any
   * caller mutation, so its absolutePath/sectionFile remain valid even
   * if the caller subsequently mutates the skeleton (the previous
   * body-holder is structurally upstream of the target and is not
   * affected by deletions or rewrites of the target subtree).
   */
  findPreviousBodyHolder(targetSectionFile: string): FlatEntry | null {
    let snapshot: FlatEntry | null = null;
    let foundTarget = false;
    this.forEachSection((heading, level, sectionFile, hp, absolutePath) => {
      if (foundTarget) return;
      if (sectionFile === targetSectionFile) {
        foundTarget = true;
        return;
      }
      snapshot = {
        headingPath: [...hp],
        heading,
        level,
        sectionFile,
        absolutePath,
        isSubSkeleton: false,
      };
    });
    if (!foundTarget) {
      throw new Error(
        `Skeleton integrity error in ${this.docPath}: target sectionFile ` +
        `${targetSectionFile} was not emitted by forEachSection. ` +
        `The skeleton may be corrupted or the caller passed a stale id.`,
      );
    }
    return snapshot;
  }

  // --- Transaction primitive ----------------------------------------

  /**
   * Apply a coordinated structural mutation as a single transaction,
   * returning a plan of the body writes and fragment-key remaps the caller
   * must perform to honor the change.
   *
   * This is the low-level replacement for the tangle of side-effects the
   * deleted replace()/insertSectionUnder() primitives used to carry out
   * implicitly. Instead of fetching-then-writing-then-remapping inline and
   * asking callers to hand-stitch the aftermath, the mutation function
   * receives a typed MutationTransactionContext and returns a record of the
   * structural decisions it made. The method then:
   *
   *   1. Validates that the returned plan is internally consistent.
   *   2. Persists the skeleton via flushToOverlay().
   *   3. Returns the plan to the caller, who is responsible for performing
   *      the body-file writes and fragment-key remaps declared in the plan.
   *
   * Callers MUST NOT short-circuit around this — either act on the full
   * plan or roll the mutation back by not calling it at all.
   *
   * This method is the only sanctioned way for other modules in this
   * package to mutate the skeleton tree after the removal of replace()
   * and its siblings.
   */
  async applyStructuralMutationTransaction(
    mutate: (ctx: MutationTransactionContext) => StructuralMutationPlan | Promise<StructuralMutationPlan>,
  ): Promise<StructuralMutationPlan> {
    const ctx: MutationTransactionContext = {
      roots: this.roots,
      docPath: this.docPath,
      findSiblingList: (parentPath) => this.findSiblingList(parentPath),
      resolveSkeletonPathFor: (parentPath) => this.resolveSkeletonPathFor(parentPath),
      flattenNode: (node, parentPath, parentSkeletonPath) =>
        this.flattenNode(node, parentPath, parentSkeletonPath),
      addBodyHoldersToParents: (nodes) => addBodyHoldersToParents(nodes),
      createBfhAtFront: () => {
        if (this.roots[0]?.level === 0 && this.roots[0]?.heading === "") {
          throw new Error(
            `createBfhAtFront() called in ${this.docPath} but a BFH ` +
            `already exists at the front of roots. Caller must check first.`,
          );
        }
        const bfhFileName = generateBeforeFirstHeadingFilename();
        const bfhNode: SkeletonNode = {
          heading: "",
          level: 0,
          sectionFile: bfhFileName,
          children: [],
        };
        this.roots.unshift(bfhNode);
        const bfhEntries = this.flattenNode(bfhNode, [], this.resolveSkeletonPathFor([]));
        const bfhEntry = bfhEntries.find((e) => e.headingPath.length === 0);
        if (!bfhEntry) {
          throw new Error(
            `Skeleton integrity error in ${this.docPath}: ` +
            `auto-created BFH did not flatten to headingPath=[]`,
          );
        }
        return bfhEntry;
      },
    };

    const plan = await mutate(ctx);
    validateMutationPlan(plan, this.docPath);
    await this.flushToOverlay();
    return plan;
  }

  // --- Heading deletion with structural body absorption (item 145) ---

  /**
   * Delete a heading section while declaring the structurally correct
   * absorption target for its orphaned body content.
   *
   * Per checklist items 143/145, this absorbs the previous-section walking,
   * document-start fabrication, and BFH/root-position branching that used
   * to live inside the normalization pipeline. Callers (now
   * StagedSectionsStore) request the semantic action and never make
   * structural decisions themselves.
   *
   * Algorithm:
   *   1. Walk forEachSection in document order, stopping at the deleted
   *      heading. The last body-holding section emitted before the stop
   *      is the merge target.
   *   2. If no merge target was emitted (the deleted heading was the very
   *      first body-holding section in the document, AND there is no BFH),
   *      a fresh BFH section is created at the front of `roots` to serve
   *      as the merge target. The plan emits an empty body file write for
   *      the new BFH.
   *   3. Inside the transaction the deleted entry is spliced from its
   *      parent sibling list and the entire removed subtree is reported.
   *
   * The body merge itself (reading the merge target's existing content,
   * appending the orphan body, writing back) is NOT performed here — the
   * caller (StagedSectionsStore + LiveFragmentStringsStore) owns the Y.Doc state and must do that step.
   * This method only declares "where the orphan body belongs" structurally.
   *
   * Throws if:
   *   - `headingPath === []` (the BFH is not deletable via heading deletion)
   *   - `headingPath` does not resolve in the current skeleton
   *   - the resolved entry is a sub-skeleton parent (use deleteSubtree
   *     for whole-subtree removal — body absorption only makes sense for
   *     leaf body-holding sections)
   */
  async deleteHeadingPreservingBody(
    headingPath: string[],
  ): Promise<{
    removed: FlatEntry[];
    mergeTarget: FlatEntry;
    mergeTargetWasCreated: boolean;
    bodyWrites: Array<{ absolutePath: string; content: string }>;
    fragmentKeyRemaps: Array<{ from: string; to: string | null }>;
  }> {
    if (headingPath.length === 0) {
      throw new Error(
        `deleteHeadingPreservingBody([]) is illegal in ${this.docPath} — ` +
        `the before-first-heading section cannot be removed via heading deletion. ` +
        `Use OverlayContentLayer.tombstoneDocumentExplicit() to remove the entire document, ` +
        `or clear the BFH body content directly via LiveFragmentStringsStore.`,
      );
    }

    const targetEntry = this.findStructuralNodeByHeadingPath(headingPath);
    if (!targetEntry) {
      throw staleHeadingPath(this.docPath, headingPath, "deleteHeadingPreservingBody");
    }
    if (targetEntry.hasChildren) {
      throw new Error(
        `deleteHeadingPreservingBody cannot delete sub-skeleton parents in ${this.docPath}: ` +
        `the entry at [${headingPath.join(" > ")}] owns child sections. ` +
        `Use OverlayContentLayer.deleteSubtree() to remove the whole subtree instead.`,
      );
    }

    // Walk forEachSection in document order to find the last body-holding
    // section emitted before the deleted target. Snapshot it BEFORE the
    // mutation so its absolutePath/sectionFile remain valid (the mutation
    // only affects the deleted entry, never the merge target).
    const mergeTargetSnapshot = this.findPreviousBodyHolder(targetEntry.sectionFile);

    // Capture across the closure boundary
    let resolvedMergeTarget: FlatEntry | null = mergeTargetSnapshot;
    let mergeTargetWasCreated = false;

    const plan = await this.applyStructuralMutationTransaction((ctx) => {
      const removed: FlatEntry[] = [];
      const added: FlatEntry[] = [];
      const bodyWrites: Array<{ absolutePath: string; content: string }> = [];
      const fragmentKeyRemaps: Array<{ from: string; to: string | null }> = [];

      // (1) Auto-create a BFH section if there is no preceding body-holder.
      if (!resolvedMergeTarget) {
        const bfhEntry = ctx.createBfhAtFront();
        added.push(bfhEntry);
        bodyWrites.push({ absolutePath: bfhEntry.absolutePath, content: "" });
        resolvedMergeTarget = bfhEntry;
        mergeTargetWasCreated = true;
      }

      // (2) Splice the deleted entry out of its parent sibling list.
      const parentPath = headingPath.slice(0, -1);
      const siblingList = ctx.findSiblingList(parentPath);
      const idx = siblingList.findIndex((n) => n.sectionFile === targetEntry.sectionFile);
      if (idx < 0) {
        throw new Error(
          `Skeleton integrity error in ${this.docPath}: target sectionFile ` +
          `${targetEntry.sectionFile} not found in expected parent sibling list at ` +
          `[${parentPath.join(" > ")}]`,
        );
      }
      const removedNode = siblingList.splice(idx, 1)[0];

      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removedEntries = ctx.flattenNode(removedNode, parentPath, parentSkeletonPath);
      removed.push(...removedEntries);

      // (3) The deleted heading's fragment key disappears with no replacement.
      // Convention matches the explicit OverlayContentLayer operations:
      // emit raw section file ids in the remap; the caller is responsible
      // for translating to fragment-key encoding.
      fragmentKeyRemaps.push({ from: targetEntry.sectionFile, to: null });

      return { removed, added, bodyWrites, fragmentKeyRemaps };
    });

    if (!resolvedMergeTarget) {
      // Defensive: the algorithm above always sets resolvedMergeTarget
      // (either from the snapshot or from BFH creation in branch 1).
      throw new Error(
        `Skeleton integrity error in ${this.docPath}: deleteHeadingPreservingBody ` +
        `failed to resolve a merge target for headingPath=[${headingPath.join(" > ")}]`,
      );
    }

    return {
      removed: plan.removed,
      mergeTarget: resolvedMergeTarget,
      mergeTargetWasCreated,
      bodyWrites: plan.bodyWrites,
      fragmentKeyRemaps: plan.fragmentKeyRemaps,
    };
  }

  // --- Parent heading collapse (item 32) --------------------------------

  /**
   * Collapse a parent heading node: remove it from the skeleton,
   * reparent its children, and declare the merge target for the orphan
   * body.
   *
   * A "parent heading" is a heading that owns a sub-skeleton (has
   * children). Collapsing it:
   *
   *   1. Finds the merge target (previous body holder in document order).
   *   2. Removes the target from its parent sibling list.
   *   3. Partitions the target's children into body-holder (carries the
   *      orphan body content) and promoted (the real child headings).
   *   4. Re-nests promoted children:
   *      - If the merge target's heading path equals the target's parent
   *        path → insert at the target's former position in the same
   *        sibling list (the merge target is the parent or a preceding
   *        body holder at the same tree level).
   *      - Otherwise → insert as children of the merge target heading
   *        node (the merge target is a preceding sibling).
   *   5. Ensures body holders exist for any newly-parented nodes.
   *
   * Returns a CollapseParentResult that the caller (OverlayContentLayer)
   * uses to drive body reads, writes, file deletion, and fragment
   * reconciliation.
   *
   * Throws if:
   *   - headingPath === [] (BFH cannot be collapsed)
   *   - headingPath does not resolve
   *   - the resolved entry is NOT a sub-skeleton parent (leaf sections
   *     use deleteHeadingPreservingBody instead)
   */
  async collapseParentHeading(
    headingPath: string[],
  ): Promise<CollapseParentResult> {
    if (headingPath.length === 0) {
      throw new Error(
        `collapseParentHeading([]) is illegal in ${this.docPath} — ` +
        `the before-first-heading section cannot be collapsed.`,
      );
    }

    const targetEntry = this.findStructuralNodeByHeadingPath(headingPath);
    if (!targetEntry) {
      throw staleHeadingPath(this.docPath, headingPath, "collapseParentHeading");
    }
    if (!targetEntry.hasChildren) {
      throw new Error(
        `collapseParentHeading requires a sub-skeleton parent in ${this.docPath}: ` +
        `the entry at [${headingPath.join(" > ")}] has no children. ` +
        `Use deleteHeadingPreservingBody() for leaf sections instead.`,
      );
    }

    // Pre-capture the target's children from the actual SkeletonNode so we
    // can separate body-holder from promoted before the transaction.
    const parentPath = headingPath.slice(0, -1);
    const preSiblings = this.findSiblingList(parentPath);
    const targetNode = preSiblings.find(n => headingsEqual(n.heading, headingPath[headingPath.length - 1]));
    if (!targetNode) {
      throw staleHeadingPath(this.docPath, headingPath, "collapseParentHeading");
    }

    // The target is a sub-skeleton parent — forEachSection emits its
    // body-holder child, not the parent file itself. Use the body-holder's
    // sectionFile for the document-order walk so findPreviousBodyHolder
    // can locate it.
    const bodyHolderNode = targetNode.children.find(c => c.level === 0 && c.heading === "");
    if (!bodyHolderNode) {
      throw new Error(
        `Skeleton integrity error in ${this.docPath}: sub-skeleton parent ` +
        `at [${headingPath.join(" > ")}] has no body-holder child.`,
      );
    }

    // Snapshot the merge target BEFORE the mutation.
    const mergeTargetSnapshot = this.findPreviousBodyHolder(bodyHolderNode.sectionFile);

    let resolvedMergeTarget: FlatEntry | null = mergeTargetSnapshot;
    let mergeTargetWasCreated = false;

    const promotedNodes = targetNode.children.filter(c => !(c.level === 0 && c.heading === ""));

    // Capture body-holder flat entry before mutation (old absolutePath).
    const targetSkeletonPath = this.resolveSkeletonPathFor(parentPath);
    const targetNodeAbsPath = path.join(`${targetSkeletonPath}.sections`, targetNode.sectionFile);
    let bodyHolderEntry: FlatEntry | null = null;
    if (bodyHolderNode) {
      bodyHolderEntry = {
        headingPath: [...headingPath],
        heading: bodyHolderNode.heading,
        level: bodyHolderNode.level,
        sectionFile: bodyHolderNode.sectionFile,
        absolutePath: path.join(`${targetNodeAbsPath}.sections`, bodyHolderNode.sectionFile),
        isSubSkeleton: false,
      };
    }

    // Capture promoted entries in OLD positions for the caller's pre-read.
    const oldPromotedEntries: FlatEntry[] = [];
    for (const pn of promotedNodes) {
      oldPromotedEntries.push(
        ...this.flattenNode(pn, headingPath, targetNodeAbsPath)
          .filter(e => !e.isSubSkeleton),
      );
    }

    let newPromotedEntries: FlatEntry[] = [];

    const plan = await this.applyStructuralMutationTransaction((ctx) => {
      const removed: FlatEntry[] = [];
      const added: FlatEntry[] = [];
      const bodyWrites: Array<{ absolutePath: string; content: string }> = [];
      const fragmentKeyRemaps: Array<{ from: string; to: string | null }> = [];

      // (1) Auto-create BFH if no merge target exists.
      if (!resolvedMergeTarget) {
        const bfhEntry = ctx.createBfhAtFront();
        added.push(bfhEntry);
        bodyWrites.push({ absolutePath: bfhEntry.absolutePath, content: "" });
        resolvedMergeTarget = bfhEntry;
        mergeTargetWasCreated = true;
      }

      // (2) Remove the target from its parent sibling list.
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex(n => n.sectionFile === targetEntry.sectionFile);
      if (idx < 0) {
        throw new Error(
          `Skeleton integrity error in ${this.docPath}: target sectionFile ` +
          `${targetEntry.sectionFile} not found in expected parent sibling list at ` +
          `[${parentPath.join(" > ")}]`,
        );
      }
      const removedNode = siblings.splice(idx, 1)[0];

      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);

      // Only the target's own sub-skeleton entry and its body holder are
      // truly removed. Promoted children are MOVED to the merge target,
      // not deleted — they must NOT appear in the removed list.
      const targetAbsPath = path.join(`${parentSkeletonPath}.sections`, removedNode.sectionFile);
      removed.push({
        headingPath: [...parentPath, removedNode.heading],
        heading: removedNode.heading,
        level: removedNode.level,
        sectionFile: removedNode.sectionFile,
        absolutePath: targetAbsPath,
        isSubSkeleton: true,
      });
      const bhChild = removedNode.children.find(c => c.level === 0 && c.heading === "");
      if (bhChild) {
        removed.push({
          headingPath: [...parentPath, removedNode.heading],
          heading: "",
          level: 0,
          sectionFile: bhChild.sectionFile,
          absolutePath: path.join(`${targetAbsPath}.sections`, bhChild.sectionFile),
          isSubSkeleton: false,
        });
      }

      // Body holder fragment key disappears (its content is absorbed into
      // the merge target). The target's sub-skeleton sectionFile is NOT a
      // fragment key — only body files produce fragment keys.
      if (bodyHolderNode) {
        fragmentKeyRemaps.push({ from: bodyHolderNode.sectionFile, to: null });
      }

      // (3) Re-nest promoted children.
      const mergeTargetHeadingPath = resolvedMergeTarget!.headingPath;
      const pathsEqual = parentPath.length === mergeTargetHeadingPath.length
        && parentPath.every((seg, i) => headingsEqual(seg, mergeTargetHeadingPath[i]));

      if (pathsEqual) {
        // Merge target is at the same tree level (parent, or a sibling that
        // is a body holder of the parent). Insert promoted children at the
        // target's former position in the same sibling list.
        // (Re-fetch siblings in case the list reference shifted after splice.)
        const currentSiblings = ctx.findSiblingList(parentPath);
        const insertIdx = Math.min(idx, currentSiblings.length);
        currentSiblings.splice(insertIdx, 0, ...promotedNodes);
      } else {
        // Merge target is a preceding sibling heading. Insert promoted
        // children as children of the merge target node.
        const mergeTargetSiblings = ctx.findSiblingList(mergeTargetHeadingPath.slice(0, -1));
        const mergeNode = mergeTargetSiblings.find(
          n => headingsEqual(n.heading, mergeTargetHeadingPath[mergeTargetHeadingPath.length - 1]),
        );
        if (!mergeNode) {
          throw new Error(
            `Skeleton integrity error in ${this.docPath}: merge target node ` +
            `[${mergeTargetHeadingPath.join(" > ")}] not found after splice.`,
          );
        }
        mergeNode.children.push(...promotedNodes);
      }

      // (4) Ensure body holders exist for any newly-parented nodes.
      ctx.addBodyHoldersToParents(ctx.roots);

      // (5) Flatten promoted entries in their NEW positions.
      const newParentPath = pathsEqual ? parentPath : mergeTargetHeadingPath;
      const newParentSkeletonPath = ctx.resolveSkeletonPathFor(newParentPath);
      for (const pn of promotedNodes) {
        const entries = ctx.flattenNode(pn, newParentPath, newParentSkeletonPath);
        newPromotedEntries.push(...entries.filter(e => !e.isSubSkeleton));
        added.push(...entries);
      }

      // (6) If the merge target transitioned from leaf to parent (it
      // gained promoted children), addBodyHoldersToParents created a new
      // body-holder child for it. The old leaf sectionFile will be
      // overwritten with skeleton markers by flushToOverlay, so update
      // resolvedMergeTarget to point to the body holder and emit a
      // fragment key remap.
      if (!mergeTargetWasCreated) {
        const mtHP = resolvedMergeTarget!.headingPath;
        if (mtHP.length > 0) {
          const mtParent = mtHP.slice(0, -1);
          const mtSiblings = ctx.findSiblingList(mtParent);
          const mtNode = mtSiblings.find(
            n => headingsEqual(n.heading, mtHP[mtHP.length - 1]),
          );
          if (mtNode && mtNode.children.length > 0) {
            const bhChild = mtNode.children.find(
              c => c.level === 0 && c.heading === "",
            );
            if (bhChild && resolvedMergeTarget!.sectionFile !== bhChild.sectionFile) {
              const oldSF = resolvedMergeTarget!.sectionFile;
              const mtParentSkPath = ctx.resolveSkeletonPathFor(mtParent);
              const mtAbsPath = path.join(
                `${mtParentSkPath}.sections`, mtNode.sectionFile,
              );
              const bhAbsPath = path.join(
                `${mtAbsPath}.sections`, bhChild.sectionFile,
              );
              resolvedMergeTarget = {
                headingPath: [...mtHP],
                heading: "",
                level: 0,
                sectionFile: bhChild.sectionFile,
                absolutePath: bhAbsPath,
                isSubSkeleton: false,
              };
              fragmentKeyRemaps.push({ from: oldSF, to: bhChild.sectionFile });
            }
          }
        }
      }

      return { removed, added, bodyWrites, fragmentKeyRemaps };
    });

    if (!resolvedMergeTarget) {
      throw new Error(
        `Skeleton integrity error in ${this.docPath}: collapseParentHeading ` +
        `failed to resolve a merge target for headingPath=[${headingPath.join(" > ")}]`,
      );
    }

    return {
      removed: plan.removed,
      mergeTarget: resolvedMergeTarget,
      mergeTargetWasCreated,
      bodyHolderEntry,
      oldPromotedEntries,
      promotedEntries: newPromotedEntries,
      bodyWrites: plan.bodyWrites,
      fragmentKeyRemaps: plan.fragmentKeyRemaps,
    };
  }

  // --- Dedicated normalization operations for StagedSectionsStore ---

  /**
   * Replace a heading node in place, preserving all of its descendants.
   *
   * This is the dedicated DSInternal operation for the
   * `normalizeHeadingRename` and `normalizeHeadingLevelChange` paths in
   * StagedSectionsStore. The caller passes the post-normalization heading
   * text and level for the exact node currently at `headingPath`; the operation:
   *
   *   1. Locates the node by walking the parent sibling list and matching
   *      the last heading-path segment via `headingsEqual`.
   *   2. Constructs a fresh `SkeletonNode` with the new heading/level and a
   *      newly minted sectionFile (always — the rename/level-change paths
   *      handle the "key did not actually change" case themselves by
   *      comparing the old and new fragment keys post-hoc).
   *   3. Splices the new node in over the old one, preserving its `children`.
   *   4. Returns the structural plan (`removed`/`added`/`fragmentKeyRemaps`)
   *      for the caller to act on. NO body writes are emitted — the caller
   *      owns the Y.Doc fragment / writeDualFormat side and writes its own
   *      raw + canonical-ready content after this method returns.
   *
   * Throws `staleHeadingPath` if `headingPath` does not resolve, or rejects
   * `headingPath === []` (the BFH section is not renameable / re-levelable
   * via this primitive — its heading is the empty string and its level is 0
   * by definition).
   */
  async replaceHeadingNodeInPlace(
    headingPath: string[],
    newHeading: string,
    newLevel: number,
  ): Promise<StructuralMutationPlan> {
    if (headingPath.length === 0) {
      throw new Error(
        `replaceHeadingNodeInPlace([]) is illegal in ${this.docPath} — ` +
        `the before-first-heading section has heading="" and level=0 by ` +
        `definition and cannot be renamed or re-leveled in place.`,
      );
    }

    return await this.applyStructuralMutationTransaction((ctx) => {
      const parentPath = headingPath.slice(0, -1);
      const target = headingPath[headingPath.length - 1];
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(this.docPath, headingPath, "replaceHeadingNodeInPlace");
      }
      const oldNode = siblings[idx];
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removed = ctx.flattenNode(oldNode, parentPath, parentSkeletonPath);

      const newSectionFile = generateSectionFilename(newHeading);
      const newNode: SkeletonNode = {
        heading: newHeading,
        level: newLevel,
        sectionFile: newSectionFile,
        children: oldNode.children,
      };
      siblings.splice(idx, 1, newNode);
      const added = ctx.flattenNode(newNode, parentPath, parentSkeletonPath);

      return {
        removed,
        added,
        bodyWrites: [],
        fragmentKeyRemaps: [{ from: oldNode.sectionFile, to: newSectionFile }],
      } satisfies StructuralMutationPlan;
    });
  }

  /**
   * Split a single heading node into multiple new sections from a parsed
   * markdown payload.
   *
   * This is the dedicated DSInternal operation for the
   * `normalizeSectionSplit` path in StagedSectionsStore. The caller passes
   * the parsed sections that resulted from re-parsing the dirty fragment's
   * content; the operation:
   *
   *   1. Locates the original node at `headingPath`.
   *   2. Partitions parsed sections into "at the original level" and
   *      "deeper than the original level". The first at-level section
   *      becomes the parent of all deeper sections (matching how
   *      `OverlayContentLayer.rewriteSubtreeFromParsedMarkdown` shapes its
   *      output, since both routes describe the same structural intent).
   *   3. Replaces the original node in its parent sibling list with the
   *      new at-level nodes (sub-skeleton body holders are added by
   *      `addBodyHoldersToParents` if needed).
   *   4. Returns the structural plan (`removed`/`added`/`fragmentKeyRemaps`).
   *      No body writes — the caller owns Y.Doc fragment populate +
   *      writeDualFormat after this method returns.
   *
   * Rejects `headingPath === []` (BFH split is not modeled here — BFH
   * normalization paths in StagedSectionsStore handle root-position fragments
   * separately).
   */
  async splitHeadingNode(
    headingPath: string[],
    parsedSections: ReadonlyArray<{ heading: string; level: number; headingPath: readonly string[] }>,
  ): Promise<StructuralMutationPlan> {
    if (headingPath.length === 0) {
      throw new Error(
        `splitHeadingNode([]) is illegal in ${this.docPath} — ` +
        `BFH/root-position split is not modeled by this primitive.`,
      );
    }
    if (parsedSections.length === 0) {
      throw new Error(
        `splitHeadingNode requires at least one parsed section in ${this.docPath} ` +
        `for headingPath=[${headingPath.join(" > ")}].`,
      );
    }

    return await this.applyStructuralMutationTransaction((ctx) => {
      const parentPath = headingPath.slice(0, -1);
      const target = headingPath[headingPath.length - 1];
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(this.docPath, headingPath, "splitHeadingNode");
      }
      const oldNode = siblings[idx];
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removed = ctx.flattenNode(oldNode, parentPath, parentSkeletonPath);

      const originalLevel = oldNode.level;
      const atLevel: Array<(typeof parsedSections)[number]> = [];
      const deeper: Array<(typeof parsedSections)[number]> = [];
      for (const sec of parsedSections) {
        if (sec.level <= originalLevel) atLevel.push(sec);
        else deeper.push(sec);
      }
      const replacements: SkeletonNode[] = atLevel.map((sec, i) => {
        const node: SkeletonNode = {
          heading: sec.heading,
          level: sec.level,
          sectionFile: generateSectionFilename(sec.heading),
          children: [],
        };
        if (i === 0) {
          for (const child of deeper) {
            node.children.push({
              heading: child.heading,
              level: child.level,
              sectionFile: generateSectionFilename(child.heading),
              children: [],
            });
          }
        }
        return node;
      });
      ctx.addBodyHoldersToParents(replacements);
      siblings.splice(idx, 1, ...replacements);

      const added: FlatEntry[] = [];
      for (const node of replacements) {
        added.push(...ctx.flattenNode(node, parentPath, parentSkeletonPath));
      }

      return {
        removed,
        added,
        bodyWrites: [],
        fragmentKeyRemaps: [{ from: oldNode.sectionFile, to: replacements[0]?.sectionFile ?? null }],
      } satisfies StructuralMutationPlan;
    });
  }

  /**
   * Append new top-level sections after the existing roots, building a
   * nested tree from each section's `headingPath` so multi-level inputs
   * (e.g., h1 with h2 children, two h1 siblings each with their own h2)
   * land at the correct depth instead of being flattened.
   *
   * This is the dedicated normalization/recovery operation for callers that
   * used to invoke the deleted `addSectionsFromBeforeFirstHeadingSplit(...)`
   * primitive. Two known call sites (item 123):
   *
   *   - StagedSectionsStore.normalizeRootSplit: a heading was typed inside the
   *     BFH fragment, splitting the BFH content into preamble + new sibling
   *     sections. The BFH itself stays at the front of `roots` (untouched
   *     by this method) and the parser-derived sections are appended after.
   *
   *   - acquireDocSession crash-recovery flow: appends a "Recovered edits"
   *     section so orphaned body content surfaces in the doc.
   *
   * Algorithm:
   *   1. Walk `parsedSections` in document order. For each section, mint a
   *      `SkeletonNode` and record it in a `headingPath → node` lookup.
   *   2. If `headingPath.slice(0, -1)` exists in the lookup, attach the new
   *      node as a child of that node (preserving nesting). Otherwise it
   *      becomes a new root-level node.
   *   3. Run `addBodyHoldersToParents(newRoots)` to materialize body-holder
   *      files for any new root that has children.
   *   4. Push the new roots onto `ctx.roots` (after any pre-existing nodes,
   *      including the BFH if present), and emit added FlatEntries via the
   *      structural plan.
   *
   * No body writes are emitted — callers (StagedSectionsStore + ydoc-lifecycle)
   * own the Y.Doc fragment populate / writeDualFormat side and handle their
   * own bodies after this method returns.
   */
  async appendRootSections(
    parsedSections: ReadonlyArray<{ heading: string; level: number; headingPath: readonly string[] }>,
  ): Promise<StructuralMutationPlan> {
    if (parsedSections.length === 0) {
      throw new Error(
        `appendRootSections requires at least one parsed section in ${this.docPath}.`,
      );
    }
    return await this.applyStructuralMutationTransaction((ctx) => {
      const newRoots: SkeletonNode[] = [];
      const lookup = new Map<string, SkeletonNode>();
      const SEP = "\u0000";

      for (const sec of parsedSections) {
        const node: SkeletonNode = {
          heading: sec.heading,
          level: sec.level,
          sectionFile: generateSectionFilename(sec.heading),
          children: [],
        };
        const key = sec.headingPath.join(SEP);
        lookup.set(key, node);

        const parentKey = sec.headingPath.slice(0, -1).join(SEP);
        const parentNode = parentKey.length > 0 ? lookup.get(parentKey) : undefined;
        if (parentNode) {
          parentNode.children.push(node);
        } else {
          newRoots.push(node);
        }
      }

      ctx.addBodyHoldersToParents(newRoots);
      ctx.roots.push(...newRoots);

      const added: FlatEntry[] = [];
      for (const node of newRoots) {
        added.push(...ctx.flattenNode(node, [], ctx.resolveSkeletonPathFor([])));
      }

      return {
        removed: [],
        added,
        bodyWrites: [],
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });
  }

  // --- Persistence ---

  /**
   * Persist skeleton to the overlay root. Always writes unconditionally.
   *
   * Flips hasBeenWrittenToOverlay true. Does NOT change loadedFromOverlay
   * (that reflects load-time provenance only). overlaySkeletonFileExisted
   * is also flipped true because the act of writing guarantees a file is
   * now present.
   *
   * PROTECTED per checklist items 139/141: this method must not be called
   * from outside the DocumentSkeleton/DocumentSkeletonInternal class
   * hierarchy. External callers should mutate skeletons via
   * `applyStructuralMutationTransaction(...)` (which persists exactly once
   * after the mutation closure runs) or via the explicit operations on
   * `OverlayContentLayer`. The previous public visibility allowed callers
   * to bypass the transaction primitive, which was the root cause of
   * coordination bugs (skeleton persisted before body writes finished,
   * fragment remaps performed against the wrong-version skeleton, etc).
   */
  protected async flushToOverlay(): Promise<void> {
    await rm(resolveTombstonePath(this.docPath, this.overlayRoot), { force: true });
    await this.writeTree(this.roots, this.skeletonPath);
    this._overlaySkeletonFileExisted = true;
    this._hasBeenWrittenToOverlay = true;
    this._overlayTombstoned = false;
  }

  // --- Static factories ---

  // NOTE per checklist item 105: createTombstone has been removed from
  // DocumentSkeletonInternal as well. The non-negotiable contract from
  // item 133 only requires that the readonly DocumentSkeleton lose this
  // capability — but item 105 also strips it from the internal subclass
  // because tombstone creation is a ContentLayer-level concern and does
  // not belong on a class whose remaining role is structural mutation.

  /**
   * Create an in-memory-only empty skeleton (no disk I/O).
   *
   * Used as a starting point for new-doc imports and for tests that need
   * a blank mutable skeleton. The returned instance has no persisted state
   * — callers must invoke flushToOverlay() to write it.
   */
  static inMemoryEmpty(
    docPath: string,
    overlayRoot: string,
  ): DocumentSkeletonInternal {
    return new DocumentSkeletonInternal(docPath, [], overlayRoot);
  }

  /**
   * The single blessed entry point for transitioning a document from
   * "missing" to "persisted live-empty in the overlay" at the skeleton
   * layer (item 166).
   *
   * Constructs a zero-root in-memory skeleton, flushes it to the overlay
   * via the protected flushToOverlay() pathway, and returns the writable
   * instance so the CURRENT caller can use it immediately within the same
   * operation if needed. No hidden extra writes — exactly one structural
   * file is written (the empty overlay skeleton file), nothing else.
   *
   * This method exists so that `OverlayContentLayer.createDocument(...)`
   * has ONE sanctioned skeleton-layer call to make for new-doc creation
   * instead of having to know the inMemoryEmpty(...) → flushToOverlay()
   * choreography. After item 161, flushToOverlay is `protected` and is
   * not directly callable from outside the DSInternal class hierarchy.
   *
   * Per item 195: this method does NOT exist to feed any cross-call
   * cache. The returned instance is for SAME-OPERATION use only — the
   * caller may use it immediately and discard it, or ignore the return
   * value entirely. Subsequent operations on the same docPath must
   * fresh-load via `mutableFromDisk(...)`.
   *
   * Caller responsibilities NOT covered by this method:
   *   - State policy (reject "live", reject "tombstone", only act on
   *     "missing") — those decisions stay in OverlayContentLayer.
   */
  static async persistNewEmptyToOverlay(
    docPath: string,
    overlayRoot: string,
  ): Promise<DocumentSkeletonInternal> {
    const skeleton = new DocumentSkeletonInternal(docPath, [], overlayRoot);
    await skeleton.flushToOverlay();
    return skeleton;
  }

  // --- Static factories ---
  // inMemoryEmpty:             creates an in-memory-only empty skeleton (no disk writes)
  // persistNewEmptyToOverlay:  creates AND persists a live-empty doc to the overlay (item 166)
  // mutableFromDisk:           loads from overlay+canonical, NEVER writes
  // materializeOverlayIfMissing: separate explicit step that persists if needed
  // fromNodes:                 builds from pre-assembled nodes (used by crash recovery)

  /**
   * Construct a skeleton from pre-assembled nodes. Used by crash recovery to build
   * a compound skeleton from multiple sources without going through mutableFromDisk().
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

  /**
   * Load a mutable skeleton from disk. This is a PURE LOAD — it never
   * writes anything to disk. Per checklist item 107, the previous
   * DocumentSkeletonInternal.fromDisk silently auto-persisted to overlay
   * when it loaded from canonical fallback, which violated its name and
   * surprised callers. That hidden write has been split off into the
   * separate materializeOverlayIfMissing() instance method below.
   */
  static async mutableFromDisk(
    docPath: string,
    overlayRoot: string,
    canonicalRoot: string,
  ): Promise<DocumentSkeletonInternal> {
    const { nodes, overlayExisted, overlayTombstoned } = await buildSkeletonTree(docPath, overlayRoot, canonicalRoot);
    validateNoDuplicateRoots(nodes, docPath);
    const skeleton = new DocumentSkeletonInternal(docPath, nodes, overlayRoot);
    skeleton._loadedFromOverlay = overlayExisted && !overlayTombstoned;
    skeleton._overlaySkeletonFileExisted = overlayExisted;
    skeleton._overlayTombstoned = overlayTombstoned;
    return skeleton;
  }

  /**
   * If this instance was loaded from canonical fallback (no overlay file
   * existed) AND it has at least one structural node, persist it into the
   * overlay so subsequent reads find it where they expect.
   *
   * Idempotent: calling this on an instance that already has an overlay
   * file is a no-op. Calling it on an empty skeleton is a no-op (an empty
   * skeleton has nothing to materialize).
   *
   * This is intentionally a separate explicit step from mutableFromDisk —
   * the previous combined behavior performed a hidden write inside a method
   * called "fromDisk", which violated the principle of least surprise and
   * masked the materialization in stack traces.
   */
  async materializeOverlayIfMissing(): Promise<void> {
    if (this._overlaySkeletonFileExisted) return;
    if (this.roots.length === 0) return;
    await this.flushToOverlay();
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

// ─── Structural mutation transaction (item 71) ───────────────────

/**
 * Context handed to a mutation closure by
 * DocumentSkeletonInternal.applyStructuralMutationTransaction.
 *
 * The closure mutates `roots` directly (it is the live tree). The helpers
 * are the same private builders DSInternal uses internally; exposing them
 * keeps mutation logic from having to re-derive sibling lookup, sub-skeleton
 * path resolution, or body-holder insertion.
 */
export interface MutationTransactionContext {
  readonly roots: SkeletonNode[];
  readonly docPath: string;
  findSiblingList(parentPath: string[]): SkeletonNode[];
  resolveSkeletonPathFor(parentPath: string[]): string;
  flattenNode(node: SkeletonNode, parentPath: string[], parentSkeletonPath: string): FlatEntry[];
  addBodyHoldersToParents(nodes: SkeletonNode[]): void;
  /**
   * Mint a fresh BFH section node at the front of `roots` and return its
   * flattened entry. Caller is responsible for pushing the returned entry
   * into its plan's `added` list, declaring an empty `bodyWrites` entry
   * for it (or its own initial body), and emitting any `fragmentKeyRemaps`.
   *
   * Throws if a BFH already exists at the front of `roots` — caller must
   * check `roots[0]?.level === 0 && roots[0]?.heading === ""` first.
   */
  createBfhAtFront(): FlatEntry;
}

/**
 * Plan returned from a structural mutation closure.
 *
 * The closure declares which entries it removed, which it added, and any
 * fragment-key remaps the caller must perform after the skeleton is
 * persisted. Body writes are NOT carried out here — the caller iterates
 * `bodyWrites` after the transaction returns and writes them through its
 * own ContentLayer-aware writer.
 *
 * This is an explicit hand-off contract that replaces the implicit ordering
 * the deleted replace()/insertSectionUnder() primitives used to perform
 * inline (which was a frequent source of partial-write bugs).
 */
export interface StructuralMutationPlan {
  removed: FlatEntry[];
  added: FlatEntry[];
  /**
   * Bodies the caller must write after the transaction returns.
   * absolutePath comes from the post-mutation flat entry; content is the
   * raw body string the caller wants to land at that path.
   */
  bodyWrites: Array<{ absolutePath: string; content: string }>;
  /**
   * Fragment-key remaps the caller (typically StagedSectionsStore) must apply.
   * `from` is the old fragment key that no longer exists post-mutation;
   * `to` is the new key (or null if the old key was simply removed).
   */
  fragmentKeyRemaps: Array<{ from: string; to: string | null }>;
}

/**
 * Validate that a returned mutation plan is internally consistent.
 *
 * The current checks are conservative — they catch shape errors and the
 * most common copy/paste mistakes — but the contract is that any caller
 * MUST be able to apply the plan without consulting the skeleton again.
 * As more invariants are discovered (e.g. body writes pointing at sub-
 * skeleton paths) they should be added here.
 */
function validateMutationPlan(plan: StructuralMutationPlan, docPath: string): void {
  if (!Array.isArray(plan.removed) || !Array.isArray(plan.added)) {
    throw new Error(
      `Skeleton mutation plan validation failed in ${docPath}: ` +
      `removed and added must be arrays.`,
    );
  }
  if (!Array.isArray(plan.bodyWrites) || !Array.isArray(plan.fragmentKeyRemaps)) {
    throw new Error(
      `Skeleton mutation plan validation failed in ${docPath}: ` +
      `bodyWrites and fragmentKeyRemaps must be arrays.`,
    );
  }
  for (const w of plan.bodyWrites) {
    if (typeof w.absolutePath !== "string" || w.absolutePath.length === 0) {
      throw new Error(
        `Skeleton mutation plan validation failed in ${docPath}: ` +
        `bodyWrites entry has empty absolutePath.`,
      );
    }
  }
  for (const r of plan.fragmentKeyRemaps) {
    if (typeof r.from !== "string" || r.from.length === 0) {
      throw new Error(
        `Skeleton mutation plan validation failed in ${docPath}: ` +
        `fragmentKeyRemaps entry has empty from-key.`,
      );
    }
  }
}
