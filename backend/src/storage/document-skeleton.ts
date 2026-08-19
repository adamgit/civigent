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
 *   structural write methods. Only used by ProposalShadowContentLayer internals
 *   and callers that need to modify skeleton structure.
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
 * - Enforce the CRDT live-edit "no duplicate sibling headings" rule as a
 *   global invariant. That rule is a CURRENT heading-path-addressability
 *   constraint of the CRDT/proposal-materialization path, NOT a claim about
 *   the canonical model. It is guarded at three focused sites — the direct
 *   skeleton-retitle primitives in `content-layer.ts` (renameHeading,
 *   retitleSubSkeletonParentInPlace, retitleSectionInPlace), the direct
 *   `moveSubtree` primitive there, and the CRDT ingress structural validator
 *   (`live-edit-structural-validation.ts`) — plus surfaced diagnostically by
 *   the document diagnostics suite. Any future relaxation of that rule
 *   should be made in those focused sites, not by widening the skeleton.
 */

import path from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { pathExists, readFileIfExists } from "./fs-primitives.js";
import type { DocStructureNode } from "../types/shared.js";
import { DocPath, HeadingLevel } from "../types/shared.js";
import { docPathToContentRelativeFsPath } from "./path-utils.js";
import { getContentRoot } from "./data-root.js";
import { staleHeadingPath } from "./skeleton-errors.js";
import { isBodyHolderShape } from "./section-shape.js";

// ─── Skeleton file format helpers ────────────────────────────────
// These are the canonical parsers/serializers for skeleton file content.
// They live here (not in markdown-sections.ts) because DocumentSkeleton
// is the single owner of all skeleton file I/O.

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const SECTION_MARKER_RE = /^\{\{section:\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}$/;

export interface SkeletonEntry {
  heading: string;
  headingLevel: HeadingLevel;
  sectionFile: string;
}

export function parseSkeletonToEntries(skeleton: string): SkeletonEntry[] {
  const lines = skeleton.split(/\r?\n/);
  const entries: SkeletonEntry[] = [];
  let pendingHeading: { text: string; headingLevel: HeadingLevel } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      pendingHeading = {
        text: headingMatch[2].trim(),
        headingLevel: HeadingLevel.parse(headingMatch[1].length),
      };
      continue;
    }

    const markerMatch = SECTION_MARKER_RE.exec(trimmed);
    if (markerMatch && pendingHeading) {
      entries.push({
        heading: pendingHeading.text,
        headingLevel: pendingHeading.headingLevel,
        sectionFile: markerMatch[1].trim(),
      });
      pendingHeading = null;
      continue;
    }
    if (markerMatch && !pendingHeading) {
      entries.push({
        heading: "",
        headingLevel: HeadingLevel.beforeFirstHeading,
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
    if (isBodyHolderShape(entry)) {
      // Body-holder shape (BFH at root, or sub-skeleton body holder): no heading line, just the section directive
      lines.push(`{{section: ${entry.sectionFile}}}`);
    } else {
      lines.push("");
      lines.push(`${"#".repeat(entry.headingLevel)} ${entry.heading}`);
      lines.push(`{{section: ${entry.sectionFile}}}`);
    }
  }
  if (lines.length === 0) return "";
  return lines.join("\n").replace(/^\n+/, "") + "\n";
}

/** The directory suffix used for section body files and sub-skeletons. */
export const SECTIONS_DIR_SUFFIX = ".sections";
export const TOMBSTONE_SUFFIX = ".tombstone";

/**
 * Effective state of a document inside a proposal content tree, resolved
 * tombstone-first then live then missing. Callers reason about proposal
 * document state — not raw storage layout. Re-exported to facade callers via
 * `proposal-facade-types`.
 */
export type ProposalDocumentState = "missing" | "live" | "tombstone";


export function resolveSkeletonPath(docPath: DocPath, contentRoot: string): string {
  return path.resolve(contentRoot, ...docPathToContentRelativeFsPath(DocPath.parse(docPath)).split("/"));
}

export function resolveCanonicalSkeletonPath(docPath: DocPath): string {
  return resolveSkeletonPath(docPath, getContentRoot());
}

export function resolveTombstonePath(docPath: DocPath, overlayRoot: string): string {
  return resolveSkeletonPath(docPath, overlayRoot) + TOMBSTONE_SUFFIX;
}

async function fileExists(filePath: string): Promise<boolean> {
  return pathExists(filePath);
}

export async function skeletonFileExists(docPath: DocPath, contentRoot: string): Promise<boolean> {
  return fileExists(resolveSkeletonPath(docPath, contentRoot));
}

/**
 * Single-root tombstone-marker existence check. A storage primitive — it makes
 * no proposal/canonical fallback decision. The proposal subsystem composes it
 * with `skeletonFileExists(...)` to resolve effective document state
 * (tombstone-first, then proposal skeleton, then canonical fallback).
 */
export async function tombstoneFileExists(docPath: DocPath, contentRoot: string): Promise<boolean> {
  return fileExists(resolveTombstonePath(docPath, contentRoot));
}

/**
 * Single-root tombstone-marker write. A mechanical storage primitive on ONE
 * content root: it writes the `.tombstone` marker file (creating parent dirs)
 * and nothing else. It carries NO proposal meaning — removing the skeleton /
 * `.sections` tree and deciding WHEN a document is "deleted" (proposal deletion
 * / rename) is the proposal subsystem's job, which composes this primitive.
 */
export async function writeTombstoneMarker(docPath: DocPath, contentRoot: string): Promise<void> {
  const tombstonePath = resolveTombstonePath(docPath, contentRoot);
  await mkdir(path.dirname(tombstonePath), { recursive: true });
  await writeFile(
    tombstonePath,
    `This file marks file ${DocPath.parse(docPath)} to be deleted when this proposal is committed\n`,
    "utf8",
  );
}

/**
 * Single-root tombstone-marker clear. A mechanical storage primitive on ONE
 * content root: it removes the `.tombstone` marker file (idempotent). The
 * decision of WHEN to clear a tombstone (document create / rename /
 * resurrection) belongs to the proposal subsystem, not here.
 */
export async function clearTombstoneMarker(docPath: DocPath, contentRoot: string): Promise<void> {
  await rm(resolveTombstonePath(docPath, contentRoot), { force: true });
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
  headingLevel: HeadingLevel;
  sectionFile: string;
  children: SkeletonNode[];
}

export interface FlatEntry {
  headingPath: string[];
  heading: string;
  headingLevel: HeadingLevel;
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
  headingLevel: HeadingLevel;
  sectionFile: string;
  absolutePath: string;
  storageRole: "direct_section" | "body_holder" | "before_first_heading";
}

export interface StructuralNodeEntry {
  kind: "structural_node";
  headingPath: string[];
  heading: string;
  headingLevel: HeadingLevel;
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

export interface HeadingRemovalMergeTarget {
  /** Pre-removal body-bearing entry. Null when the anchor was newly created. */
  oldEntry: FlatEntry | null;
  /** Post-removal body-bearing entry (a body-holder when the merge target is or became a parent). */
  newEntry: FlatEntry;
  /** User-visible identity of the merge target: the owning parent's heading for a
   *  body-holder, `""`/level 0 for the document BFH, the entry's own heading otherwise. */
  visibleHeadingPath: string[];
  visibleHeading: string;
  visibleHeadingLevel: HeadingLevel;
  /** True when the merge target is a newly-created document-start BFH anchor. */
  wasCreated: boolean;
  /** Completed by the heading-removal executor (content layer): the merge target's
   *  post-merge body. Null when its stored body was left untouched. */
  mergedBody: string | null;
}

export interface HeadingRemovalEffect {
  /** The removed heading's OWN identities only: its named entry (sub-skeleton entry
   *  when a parent, leaf entry otherwise) first, then its body-holder when a parent.
   *  Preserved descendants are NEVER in this list. */
  removedTargetEntries: FlatEntry[];
  /** The removed heading's body-bearing section-file id (the live fragment id). */
  removedBodySectionFile: string;
  /** Where the orphan body belongs, or null when nothing precedes the removed
   *  heading and no body content had to survive (no anchor is fabricated). */
  mergeTarget: HeadingRemovalMergeTarget | null;
  /** Exact section-file ids the removal deletes. */
  deletedSectionFileIds: string[];
  /** Preserved descendants (body-bearing entries), ids/levels/order unchanged,
   *  with their old and new positions. */
  preservedDescendants: Array<{ oldEntry: FlatEntry; newEntry: FlatEntry }>;
  /** Fragment-key changes (section-file ids; `to: null` = key removed). */
  fragmentKeyChanges: Array<{ from: string; to: string | null }>;
  /** Body writes the removal mandates structurally (created-anchor placeholder). */
  bodyWrites: Array<{ absolutePath: string; content: string }>;
  /** Resulting ordered content layout (whole document, body-bearing entries). */
  resultingLayout: FlatEntry[];
}

// ─── DocumentSkeleton (readonly) ────────────────────────────────

export class DocumentSkeleton {
  readonly docPath: DocPath;
  protected roots: SkeletonNode[];

  // `hasBeenWrittenToOverlay`: this specific in-memory instance has successfully
  // persisted its state to the overlay since being constructed (via persistSkeletonTree
  // or a factory that auto-persists). The load-time "loaded from proposal root vs
  // canonical fallback" provenance flags were removed: no caller needs them, and
  // the only internal consumer (`materializeInheritedSkeletonFromCanonical`) now
  // reads disk state on demand via the single-root primitives.
  protected _hasBeenWrittenToOverlay: boolean = false;

  protected readonly overlayRoot: string;

  /**
   * Optional placeholder-suppression policy injected by the proposal subsystem.
   * `DocumentSkeleton` is single-root and has NO canonical knowledge of its own:
   * when `writeTree()` is about to synthesize an empty body-holder placeholder, it
   * asks this policy whether a body for that file already exists in a shadowed
   * (canonical) layer — if so, the placeholder is skipped so the canonical body
   * is not shadowed. Absent (single-layer / canonical tooling) → always synthesize.
   *
   * This is how the spec's "DocumentSkeleton reads one content root, the proposal
   * facades compose canonical fallback" boundary is honoured: the canonical
   * awareness lives in the closure the proposal subsystem supplies, not in DS.
   */
  protected _shadowBodyExists?: (bodyFilePath: string) => Promise<boolean>;

  protected constructor(
    docPath: DocPath,
    roots: SkeletonNode[],
    contentRoot: string,
  ) {
    this.docPath = docPath;
    this.roots = roots;
    this.overlayRoot = contentRoot;
  }

  /**
   * True when this in-memory instance has persisted its state to the
   * overlay since being constructed.
   */
  get hasBeenWrittenToOverlay(): boolean { return this._hasBeenWrittenToOverlay; }

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
      headingLevel: HeadingLevel,
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
      headingLevel: HeadingLevel,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
    ) => void,
  ): void {
    this.forEachNode((heading, headingLevel, sectionFile, headingPath, absolutePath, isSubSkeleton) => {
      if (!isSubSkeleton) cb(heading, headingLevel, sectionFile, headingPath, absolutePath);
    });
  }

  /**
   * Iterate user-visible content sections in document order.
   *
   * Like `forEachSection()`, but for a body-holder child of a sub-skeleton parent
   * (`parentPath.length > 0`, `heading=""`, `level=0`) the callback receives the
   * parent's visible heading and level instead of the body-holder's anonymous
   * `("", 0)` shape. `sectionFile` and `absolutePath` still point at the
   * body-holder's own body file. The document-level BFH (`parentPath.length === 0`)
   * is emitted unchanged. Sub-skeleton parents themselves are skipped — their
   * content lives in the body-holder child that was just folded onto them.
   *
   * Use this for user-visible read paths (assembled documents, section lists,
   * heading-path discovery). Internal structural code keeps using
   * `forEachNode`/`forEachSection` to see the literal skeleton shape.
   */
  forEachVisibleSection(
    cb: (
      heading: string,
      headingLevel: HeadingLevel,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
    ) => void,
  ): void {
    this.walkVisibleSections(this.roots, [], this.skeletonPath, undefined, undefined, cb);
  }

  protected walkVisibleSections(
    nodes: SkeletonNode[],
    hp: string[],
    parentSkeletonPath: string,
    parentVisibleHeading: string | undefined,
    parentVisibleLevel: HeadingLevel | undefined,
    cb: (
      heading: string,
      headingLevel: HeadingLevel,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
    ) => void,
  ): void {
    const sectionsDir = `${parentSkeletonPath}.sections`;
    for (const node of nodes) {
      const isBfh = isBodyHolderShape(node);
      const isSubSkeleton = node.children.length > 0;
      if (!isBfh) hp.push(node.heading);
      const absPath = path.join(sectionsDir, node.sectionFile);

      if (isSubSkeleton) {
        // Sub-skeleton parent: skip emit; recurse with this node as the
        // visible parent so a nested body-holder child can fold onto it.
        this.walkVisibleSections(node.children, hp, absPath, node.heading, node.headingLevel, cb);
      } else if (isBfh && parentVisibleHeading !== undefined && parentVisibleLevel !== undefined) {
        // Nested body-holder: emit with parent's visible heading/level,
        // but keep sectionFile/absolutePath pointed at the body-holder's body file.
        cb(parentVisibleHeading, parentVisibleLevel, node.sectionFile, hp, absPath);
      } else {
        // Normal section, or root-level BFH (no sub-skeleton parent above).
        cb(node.heading, node.headingLevel, node.sectionFile, hp, absPath);
      }

      if (!isBfh) hp.pop();
    }
  }

  protected walkNodes(
    nodes: SkeletonNode[],
    hp: string[],
    parentSkeletonPath: string,
    cb: (
      heading: string,
      headingLevel: HeadingLevel,
      sectionFile: string,
      headingPath: string[],
      absolutePath: string,
      isSubSkeleton: boolean,
    ) => void,
  ): void {
    const sectionsDir = `${parentSkeletonPath}.sections`;
    for (const node of nodes) {
      const isBfh = isBodyHolderShape(node);
      if (!isBfh) hp.push(node.heading);
      const absPath = path.join(sectionsDir, node.sectionFile);
      const isSubSkeleton = node.children.length > 0;
      cb(node.heading, node.headingLevel, node.sectionFile, hp, absPath, isSubSkeleton);
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
      heading_level: HeadingLevel.parse(n.headingLevel),
      children: this.toDocStructureNodes(n.children),
    }));
  }

  protected makeStructuralNodeEntry(
    node: SkeletonNode,
    parentPath: string[],
    parentSkeletonPath: string,
  ): StructuralNodeEntry {
    const isBfh = isBodyHolderShape(node);
    const headingPath = isBfh ? [...parentPath] : [...parentPath, node.heading];
    const absolutePath = path.join(`${parentSkeletonPath}.sections`, node.sectionFile);
    return {
      kind: "structural_node",
      headingPath,
      heading: node.heading,
      headingLevel: node.headingLevel,
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
        headingLevel: structuralNode.headingLevel,
        sectionFile: bodyHolderSectionFile,
        absolutePath: path.join(`${structuralNode.absolutePath}.sections`, bodyHolderSectionFile),
        storageRole: structuralNode.headingPath.length === 0 ? "before_first_heading" : "body_holder",
      };
    }
    return {
      kind: "content_entry",
      headingPath: [...structuralNode.headingPath],
      heading: structuralNode.heading,
      headingLevel: structuralNode.headingLevel,
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
    const rootNode = this.roots.find(n => isBodyHolderShape(n));
    if (!rootNode) {
      return null;
    }
    const structuralNode = this.makeStructuralNodeEntry(rootNode, [], this.skeletonPath);
    const bodyHolder = rootNode.children.find(c => isBodyHolderShape(c));
    return this.makeContentEntry(structuralNode, bodyHolder?.sectionFile);
  }

  /**
   * Resolve the before-first-heading structural node directly from this.roots.
   * Returns null if the skeleton is empty (tombstone) or has no BFH node.
   */
  protected findBeforeFirstHeadingStructuralNode(): StructuralNodeEntry | null {
    const rootNode = this.roots.find(n => isBodyHolderShape(n));
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
        headingLevel: root.headingLevel,
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
        headingLevel: root.headingLevel,
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
      const isBfh = isBodyHolderShape(node);
      const hp = isBfh ? parentPath : [...parentPath, node.heading];
      const absPath = path.join(sectionsDir, node.sectionFile);
      if (node.sectionFile === targetFile) {
        return {
          headingPath: [...hp],
          heading: node.heading,
          headingLevel: node.headingLevel,
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
        const bodyHolder = node.children.find(c => isBodyHolderShape(c));
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
    this.forEachSection((heading, headingLevel, sectionFile, hp, absolutePath) => {
      entries.push({ headingPath: [...hp], heading, headingLevel, sectionFile, absolutePath, isSubSkeleton: false });
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
    this.forEachNode((heading, headingLevel, sectionFile, hp, absolutePath, isSubSkeleton) => {
      entries.push({
        headingPath: [...hp],
        heading,
        headingLevel,
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
    this.forEachNode((heading, headingLevel, sectionFile) => {
      out.push({ heading, headingLevel, sectionFile });
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
  static sectionsDir(docPath: DocPath, contentRoot: string): string {
    return resolveSkeletonPath(docPath, contentRoot) + ".sections";
  }

  /**
   * Single-root skeleton load: read the structural tree from EXACTLY one content
   * root with NO overlay→canonical fallback and NO tombstone handling. Returns an
   * empty skeleton when no skeleton file exists at `contentRoot`. Body I/O on the
   * returned instance is bound to that same single root.
   *
   * This is the single-layer read API — use it for canonical-only / single-root
   * reads instead of the `fromDisk(docPath, root, root)` trick. The proposal
   * subsystem composes proposal-root structure, tombstone state, and canonical
   * fallback via the effective-load `fromDisk(...)`.
   */
  static async fromSingleRoot(docPath: DocPath, contentRoot: string): Promise<DocumentSkeleton> {
    const nodes = await readTreeRecursive(resolveSkeletonPath(docPath, contentRoot));
    validateNoDuplicateRoots(nodes, docPath);
    return new DocumentSkeleton(docPath, nodes, contentRoot);
  }

  /**
   * Effective-load (read): resolve the document's STRUCTURE across a proposal
   * content root (`overlayRoot`) with canonical (`canonicalRoot`) fallback. This
   * is the proposal-owned effective read, composed by the proposal subsystem
   * (`ProposalShadowContentLayer`, behind `ProposalReader`/`ProposalEditor`) and
   * by the DocSession seed which reads the current proposal's effective skeleton.
   *
   * The returned instance is bound to a SINGLE content root (`overlayRoot`): reads
   * are read-only and section bodies are resolved by the proposal subsystem's
   * `readEffectiveSectionBody()` (which falls back to canonical), so the instance
   * needs no canonical knowledge. NOT for single-root structure reads — use
   * `fromSingleRoot(...)`.
   */
  static async fromDisk(
    docPath: DocPath,
    overlayRoot: string,
    canonicalRoot: string,
    deletedSectionFiles?: ReadonlySet<string>,
  ): Promise<DocumentSkeleton> {
    const nodes = await buildSkeletonTree(docPath, overlayRoot, canonicalRoot, deletedSectionFiles);
    validateNoDuplicateRoots(nodes, docPath);
    return new DocumentSkeleton(docPath, nodes, overlayRoot);
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
      const isBfh = isBodyHolderShape(node);
      const hp = isBfh ? [...parentPath] : [...parentPath, node.heading];
      const absPath = path.join(sectionsDir, node.sectionFile);
      result.push({
        headingPath: hp,
        heading: node.heading,
        headingLevel: node.headingLevel,
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
    const isBfh = isBodyHolderShape(node);
    const hp = isBfh ? [...parentPath] : [...parentPath, node.heading];
    const absPath = path.join(sectionsDir, node.sectionFile);
    const result: FlatEntry[] = [{
      headingPath: hp,
      heading: node.heading,
      headingLevel: node.headingLevel,
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
   * Shadow-suppression rule: before synthesizing an empty placeholder, DS asks
   * the injected `_shadowBodyExists` policy (when present) whether a body for that
   * file already exists in a shadowed layer. If so it skips the placeholder, so a
   * non-empty canonical body is not shadowed for untouched nested parents (the
   * proposal subsystem's `readEffectiveSectionBody()` falls back to canonical, so
   * the "body must exist somewhere" invariant still holds). DS holds NO canonical
   * knowledge of its own — the closure is supplied by the proposal subsystem.
   * Truly new structures (no shadowed body) still get the placeholder.
   */
  protected async writeTree(
    nodes: SkeletonNode[],
    skeletonPath: string,
    isSubSkeleton = false,
  ): Promise<void> {
    const content = serializeSkeletonEntries(
      nodes.map(n => ({ heading: n.heading, headingLevel: n.headingLevel, sectionFile: n.sectionFile })),
    );
    await mkdir(path.dirname(skeletonPath), { recursive: true });
    await writeFile(skeletonPath, content, "utf8");

    const sectionsDir = `${skeletonPath}.sections`;

    // Ensure body holder files exist inside sub-skeletons
    if (isSubSkeleton) {
      for (const node of nodes) {
        if (isBodyHolderShape(node)) {
          const bodyFilePath = path.join(sectionsDir, node.sectionFile);
          if (await pathExists(bodyFilePath)) continue;

          // Proposal subsystem shadow policy: if a body for this file already
          // exists in a shadowed (canonical) layer, do NOT synthesize an empty
          // placeholder — that would shadow the non-empty canonical content for
          // untouched nested parents. DS itself has no canonical knowledge; the
          // proposal subsystem injects this closure (absent → always synthesize).
          if (this._shadowBodyExists && (await this._shadowBodyExists(bodyFilePath))) continue;

          await mkdir(sectionsDir, { recursive: true });
          await writeFile(bodyFilePath, "", "utf8");
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
 * and persistence. Restricted to ProposalShadowContentLayer internals
 * and callers that need to modify skeleton structure.
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
  // through the ProposalShadowContentLayer / store migration items in this checklist.

  // --- Document-order navigation helpers ----------------------------

  /**
   * Walk forEachSection in document order and return the last
   * body-holding section emitted strictly BEFORE the section identified
   * by `targetSectionFile`. Returns null if `targetSectionFile` is the
   * very first body-holder in the document. Throws if `targetSectionFile`
   * is not present in the skeleton at all (corrupted skeleton or stale
   * caller-provided id).
   *
   * Used by `removeHeading` to locate the orphan absorption target, and by
   * item 369 `replaceSubtreeDeletingOmittedSections` to locate the merge
   * target for `leadingOrphanBody` absorption.
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
    this.forEachSection((heading, headingLevel, sectionFile, hp, absolutePath) => {
      if (foundTarget) return;
      if (sectionFile === targetSectionFile) {
        foundTarget = true;
        return;
      }
      snapshot = {
        headingPath: [...hp],
        heading,
        headingLevel,
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
   *   2. Persists the skeleton via persistSkeletonTree().
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
        if (this.roots[0]?.headingLevel === 0 && this.roots[0]?.heading === "") {
          throw new Error(
            `createBfhAtFront() called in ${this.docPath} but a BFH ` +
            `already exists at the front of roots. Caller must check first.`,
          );
        }
        const bfhFileName = generateBeforeFirstHeadingFilename();
        const bfhNode: SkeletonNode = {
          heading: "",
          headingLevel: HeadingLevel.beforeFirstHeading,
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
    await this.persistSkeletonTree();
    return plan;
  }

  // --- Heading removal (one engine: predecessor merge / document-start anchor / reparent) ---

  /**
   * Remove ONE heading from the skeleton — the single heading-removal operation.
   *
   * Structure only; no file I/O beyond skeleton persistence. The caller
   * (ProposalShadowContentLayer.removeHeading) owns body reads/writes/deletes and
   * completes the returned effect with the merged body.
   *
   *  - The merge target (where the removed heading's orphan body belongs) is the
   *    last body-bearing entry emitted BEFORE the target in the skeleton's
   *    document-order walk. An existing BFH is an ordinary predecessor.
   *  - When no predecessor exists, a document-start BFH anchor is created ONLY
   *    when `createDocumentStartAnchor` is true (body content must survive before
   *    the first remaining heading); otherwise `mergeTarget` is null and nothing
   *    is fabricated.
   *  - Only the target heading's OWN identities (named entry + body-holder) are
   *    removed. Real descendants are reparented at UNCHANGED section-file ids,
   *    levels, order, and bodies: each attaches under the deepest heading that
   *    remains open before it in flat document order with a smaller level —
   *    exactly where the flat markdown minus the removed heading line nests it.
   *    A leaf attach point becomes a parent id-preservingly (its body file id
   *    becomes the body-holder id; a fresh sub-skeleton id is minted), so its
   *    live fragment key survives.
   *
   * Throws when `headingPath` is `[]` (the BFH has no heading to remove) or does
   * not resolve in the current skeleton.
   */
  async removeHeading(
    headingPath: string[],
    opts: { createDocumentStartAnchor: boolean },
  ): Promise<HeadingRemovalEffect> {
    if (headingPath.length === 0) {
      throw new Error(
        `removeHeading([]) is illegal in ${this.docPath} — the before-first-heading ` +
        `section has no heading to remove. Clear its body content or delete the ` +
        `whole document instead.`,
      );
    }

    const targetEntry = this.findStructuralNodeByHeadingPath(headingPath);
    if (!targetEntry) {
      throw staleHeadingPath(this.docPath, headingPath, "removeHeading");
    }

    const parentPath = headingPath.slice(0, -1);
    const preSiblings = this.findSiblingList(parentPath);
    const preIdx = preSiblings.findIndex((n) => n.sectionFile === targetEntry.sectionFile);
    if (preIdx < 0) {
      throw new Error(
        `Skeleton integrity error in ${this.docPath}: target sectionFile ` +
        `${targetEntry.sectionFile} not found in expected parent sibling list at ` +
        `[${parentPath.join(" > ")}]`,
      );
    }
    const targetNode = preSiblings[preIdx];

    const bodyHolderChild = targetNode.children.find((c) => isBodyHolderShape(c)) ?? null;
    if (targetNode.children.length > 0 && !bodyHolderChild) {
      throw new Error(
        `Skeleton integrity error in ${this.docPath}: sub-skeleton parent ` +
        `at [${headingPath.join(" > ")}] has no body-holder child.`,
      );
    }
    const removedBodySectionFile = bodyHolderChild
      ? bodyHolderChild.sectionFile
      : targetNode.sectionFile;

    const mergeTargetSnapshot = this.findPreviousBodyHolder(removedBodySectionFile);

    let mergeVisible: { headingPath: string[]; heading: string; headingLevel: HeadingLevel } | null = null;
    if (mergeTargetSnapshot) {
      const snapshot: FlatEntry = mergeTargetSnapshot;
      if (snapshot.headingPath.length === 0) {
        mergeVisible = { headingPath: [], heading: "", headingLevel: HeadingLevel.beforeFirstHeading };
      } else if (snapshot.heading === "") {
        const owner = this.requireStructuralNodeByHeadingPath(snapshot.headingPath);
        mergeVisible = {
          headingPath: [...snapshot.headingPath],
          heading: owner.heading,
          headingLevel: owner.headingLevel,
        };
      } else {
        mergeVisible = {
          headingPath: [...snapshot.headingPath],
          heading: snapshot.heading,
          headingLevel: snapshot.headingLevel,
        };
      }
    }

    const parentSkeletonPath = this.resolveSkeletonPathFor(parentPath);
    const targetFlat = this.flattenNode(targetNode, parentPath, parentSkeletonPath);
    const removedTargetIds = new Set<string>(
      [targetNode.sectionFile, ...(bodyHolderChild ? [bodyHolderChild.sectionFile] : [])],
    );
    const removedTargetEntries = targetFlat.filter((e) => removedTargetIds.has(e.sectionFile));
    const oldDescendantEntries = targetFlat.filter(
      (e) => !e.isSubSkeleton && !removedTargetIds.has(e.sectionFile),
    );
    const realChildren = targetNode.children.filter((c) => !isBodyHolderShape(c));

    let createdBfhEntry: FlatEntry | null = null;

    const plan = await this.applyStructuralMutationTransaction((ctx) => {
      const removed: FlatEntry[] = [...removedTargetEntries];
      const added: FlatEntry[] = [];
      const bodyWrites: Array<{ absolutePath: string; content: string }> = [];
      const fragmentKeyRemaps: Array<{ from: string; to: string | null }> = [
        { from: removedBodySectionFile, to: null },
      ];

      if (!mergeTargetSnapshot && opts.createDocumentStartAnchor) {
        createdBfhEntry = ctx.createBfhAtFront();
        added.push(createdBfhEntry);
        bodyWrites.push({ absolutePath: createdBfhEntry.absolutePath, content: "" });
      }

      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => n.sectionFile === targetNode.sectionFile);
      if (idx < 0) {
        throw new Error(
          `Skeleton integrity error in ${this.docPath}: target sectionFile ` +
          `${targetNode.sectionFile} disappeared from its parent sibling list at ` +
          `[${parentPath.join(" > ")}] during removeHeading.`,
        );
      }

      // The poppable open-heading chain at the removal point: the rightmost
      // real-heading descent of the nearest preceding REAL sibling (a preceding
      // BFH/body-holder is a body predecessor, never a nesting anchor). Ancestors
      // form the fixed floor: a preserved descendant's level is always greater
      // than the target's (hence every ancestor's), so popping never crosses it.
      const descent: SkeletonNode[] = [];
      for (let j = idx - 1; j >= 0; j--) {
        if (isBodyHolderShape(siblings[j])) continue;
        let node = siblings[j];
        descent.push(node);
        for (;;) {
          const realKids = node.children.filter((c) => !isBodyHolderShape(c));
          if (realKids.length === 0) break;
          node = realKids[realKids.length - 1];
          descent.push(node);
        }
        break;
      }

      siblings.splice(idx, 1);

      let parentInsertIdx = idx;
      for (const child of realChildren) {
        while (descent.length > 0 && descent[descent.length - 1].headingLevel >= child.headingLevel) {
          descent.pop();
        }
        if (descent.length === 0) {
          siblings.splice(parentInsertIdx++, 0, child);
        } else {
          const attach = descent[descent.length - 1];
          if (attach.children.length === 0) {
            const bodyId = attach.sectionFile;
            attach.sectionFile = generateSectionFilename(attach.heading);
            attach.children.push({
              heading: "",
              headingLevel: HeadingLevel.beforeFirstHeading,
              sectionFile: bodyId,
              children: [],
            });
          }
          attach.children.push(child);
        }
        descent.push(child);
      }

      return { removed, added, bodyWrites, fragmentKeyRemaps };
    });

    const bodyEntriesAfter = new Map<string, FlatEntry>();
    for (const entry of this.allStructuralEntries()) {
      if (!entry.isSubSkeleton) bodyEntriesAfter.set(entry.sectionFile, entry);
    }

    const preservedDescendants = oldDescendantEntries.map((oldEntry) => {
      const newEntry = bodyEntriesAfter.get(oldEntry.sectionFile);
      if (!newEntry) {
        throw new Error(
          `Skeleton integrity error in ${this.docPath}: removeHeading lost preserved ` +
          `descendant section file ${oldEntry.sectionFile}.`,
        );
      }
      return { oldEntry, newEntry };
    });

    let mergeTarget: HeadingRemovalMergeTarget | null = null;
    if (createdBfhEntry) {
      mergeTarget = {
        oldEntry: null,
        newEntry: createdBfhEntry,
        visibleHeadingPath: [],
        visibleHeading: "",
        visibleHeadingLevel: HeadingLevel.beforeFirstHeading,
        wasCreated: true,
        mergedBody: null,
      };
    } else if (mergeTargetSnapshot && mergeVisible) {
      const snapshot: FlatEntry = mergeTargetSnapshot;
      const newEntry = bodyEntriesAfter.get(snapshot.sectionFile);
      if (!newEntry) {
        throw new Error(
          `Skeleton integrity error in ${this.docPath}: removeHeading lost the merge ` +
          `target section file ${snapshot.sectionFile}.`,
        );
      }
      mergeTarget = {
        oldEntry: snapshot,
        newEntry,
        visibleHeadingPath: mergeVisible.headingPath,
        visibleHeading: mergeVisible.heading,
        visibleHeadingLevel: mergeVisible.headingLevel,
        wasCreated: false,
        mergedBody: null,
      };
    }

    return {
      removedTargetEntries: plan.removed,
      removedBodySectionFile,
      mergeTarget,
      deletedSectionFileIds: [...removedTargetIds],
      preservedDescendants,
      fragmentKeyChanges: plan.fragmentKeyRemaps,
      bodyWrites: plan.bodyWrites,
      resultingLayout: this.allContentEntries(),
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
    newHeadingLevel: HeadingLevel,
  ): Promise<StructuralMutationPlan> {
    if (headingPath.length === 0) {
      throw new Error(
        `replaceHeadingNodeInPlace([]) is illegal in ${this.docPath} — ` +
        `the before-first-heading section has heading="" and headingLevel=0 by ` +
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
        headingLevel: newHeadingLevel,
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
   *      `ProposalShadowContentLayer.replaceSubtreeDeletingOmittedSections` shapes its
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
    parsedSections: ReadonlyArray<{ heading: string; headingLevel: HeadingLevel; headingPath: readonly string[] }>,
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

      const originalLevel = oldNode.headingLevel;
      const atLevel: Array<(typeof parsedSections)[number]> = [];
      const deeper: Array<(typeof parsedSections)[number]> = [];
      for (const sec of parsedSections) {
        if (sec.headingLevel <= originalLevel) atLevel.push(sec);
        else deeper.push(sec);
      }
      const replacements: SkeletonNode[] = atLevel.map((sec, i) => {
        const node: SkeletonNode = {
          heading: sec.heading,
          headingLevel: sec.headingLevel,
          sectionFile: generateSectionFilename(sec.heading),
          children: [],
        };
        if (i === 0) {
          for (const child of deeper) {
            node.children.push({
              heading: child.heading,
              headingLevel: child.headingLevel,
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
   * Dedicated structural append for callers that need to add newly parsed
   * top-level sections after the existing roots (e.g. a heading typed inside
   * the BFH fragment: preamble stays as BFH; parser-derived siblings are
   * appended after). There is no crash-recovery / "Recovered edits" call site —
   * startup recovery no longer writes recovery appendices into documents.
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
    parsedSections: ReadonlyArray<{ heading: string; headingLevel: HeadingLevel; headingPath: readonly string[] }>,
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
          headingLevel: sec.headingLevel,
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
   * Low-level single-root skeleton writer: write this skeleton's tree to its own
   * content root. Always writes unconditionally. This is NOT a semantic "flush to
   * overlay" operation — it makes no proposal/canonical decision and carries no
   * deletion/rename meaning; it just serializes the in-memory tree to disk at the
   * one root this instance owns. Used only by proposal-owned mutations
   * (`applyStructuralMutationTransaction`, the empty-skeleton factory, first-edit
   * materialization) and canonical-only tooling.
   *
   * Flips hasBeenWrittenToOverlay true. Load-time provenance is no longer tracked
   * on the instance — callers that need to know whether a proposal-root
   * skeleton/tombstone exists read it from disk via the single-root primitives.
   *
   * PROTECTED per checklist items 139/141: this method must not be called from
   * outside the DocumentSkeleton/DocumentSkeletonInternal class hierarchy.
   * External callers should mutate skeletons via
   * `applyStructuralMutationTransaction(...)` (which persists exactly once after
   * the mutation closure runs) or via the explicit operations on
   * `ProposalShadowContentLayer`. The previous public visibility allowed callers
   * to bypass the transaction primitive, which was the root cause of coordination
   * bugs (skeleton persisted before body writes finished, fragment remaps
   * performed against the wrong-version skeleton, etc).
   *
   * Body-holder placeholders are written by `writeTree()` only when no canonical
   * body file exists at the same relative path. Intentional "clear body" semantics
   * travel through `ProposalShadowContentLayer` writes, not through this method.
   * Don't add a read-time empty-file fallback to compensate — see `writeTree()`.
   */
  protected async persistSkeletonTree(): Promise<void> {
    // No tombstone clearing here: this generic writer carries no deletion/rename
    // meaning. A proposal tombstone is cleared only by explicit proposal
    // document-create / document-rename / document-resurrection semantics (via the
    // `clearTombstoneMarker` primitive). All paths that reach this writer have
    // already rejected tombstoned documents upstream.
    await this.writeTree(this.roots, this.skeletonPath);
    this._hasBeenWrittenToOverlay = true;
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
   * — callers must invoke persistSkeletonTree() to write it.
   */
  static inMemoryEmpty(
    docPath: DocPath,
    overlayRoot: string,
  ): DocumentSkeletonInternal {
    return new DocumentSkeletonInternal(docPath, [], overlayRoot);
  }

  /**
   * The single blessed entry point for creating an empty `DocumentSkeleton`
   * in a given content root at the skeleton layer.
   *
   * Constructs a zero-root in-memory skeleton, persists it into `contentRoot`
   * via the protected persistSkeletonTree() pathway, and returns the writable
   * instance so the CURRENT caller can use it immediately within the same
   * operation if needed. No hidden extra writes — exactly one structural
   * file is written (the empty skeleton file), nothing else. `contentRoot`
   * is whatever content root the caller owns (a proposal content root, or a
   * canonical root for canonical-only tooling); this method does not know or
   * care which.
   *
   * This method exists so that callers such as
   * `ProposalShadowContentLayer.createDocument(...)` have ONE sanctioned
   * skeleton-layer call to make for new-doc creation instead of having to
   * know the inMemoryEmpty(...) → persistSkeletonTree() choreography. persistSkeletonTree
   * is `protected` and is not directly callable from outside the DSInternal
   * class hierarchy.
   *
   * This method does NOT exist to feed any cross-call cache. The returned
   * instance is for SAME-OPERATION use only — the caller may use it
   * immediately and discard it, or ignore the return value entirely.
   * Subsequent operations on the same docPath must fresh-load via
   * `mutableFromDisk(...)`.
   *
   * Caller responsibilities NOT covered by this method:
   *   - State policy (reject "live", reject "tombstone", only act on
   *     "missing") — those decisions stay with the proposal-owned caller.
   */
  static async createEmptySkeletonInRoot(
    docPath: DocPath,
    contentRoot: string,
  ): Promise<DocumentSkeletonInternal> {
    const skeleton = new DocumentSkeletonInternal(docPath, [], contentRoot);
    await skeleton.persistSkeletonTree();
    return skeleton;
  }

  // --- Static factories ---
  // inMemoryEmpty:             creates an in-memory-only empty skeleton (no disk writes)
  // createEmptySkeletonInRoot: creates AND persists an empty skeleton into a content root
  // loadNodesFromRoot:         single-root structure read (no instance), for proposal-composed loads
  // fromNodes:                 builds a single-root mutable skeleton from pre-assembled nodes
  // materializeInheritedSkeletonFromCanonical: first-edit canonical init (persists inherited structure)

  /**
   * Single-root structure read: read the skeleton node tree from EXACTLY one
   * content root (no fallback). Returns `[]` when the skeleton file is absent.
   * The proposal subsystem composes the proposal-root-or-canonical decision and
   * passes the result to `fromNodes(...)`; DS itself never chooses between roots.
   */
  static async loadNodesFromRoot(docPath: DocPath, contentRoot: string): Promise<SkeletonNode[]> {
    const nodes = await readTreeRecursive(resolveSkeletonPath(docPath, contentRoot));
    validateNoDuplicateRoots(nodes, docPath);
    return nodes;
  }

  /**
   * Construct a single-root mutable skeleton bound to `contentRoot` from
   * pre-assembled nodes. This is the spec-aligned mutable factory: it takes ONE
   * content root (writes go there) and an OPTIONAL `shadowBodyExists` policy by
   * which the proposal subsystem injects canonical-fallback awareness for
   * placeholder suppression — DS holds no canonical knowledge itself. Used by the
   * proposal write path (structure loaded via `loadNodesFromRoot`) and by crash
   * recovery (no policy — recovery writes a self-contained tree).
   */
  static fromNodes(
    docPath: DocPath,
    nodes: SkeletonNode[],
    contentRoot: string,
    shadowBodyExists?: (bodyFilePath: string) => Promise<boolean>,
  ): DocumentSkeletonInternal {
    validateNoDuplicateRoots(nodes, docPath);
    const skeleton = new DocumentSkeletonInternal(docPath, nodes, contentRoot);
    if (shadowBodyExists) skeleton._shadowBodyExists = shadowBodyExists;
    return skeleton;
  }

  /**
   * Manifest-overlay absorb (Step 5a): persist a pre-assembled (already merged)
   * node tree as the skeleton at `root`, writing only the structural listing
   * files and sub-skeleton body-holder placeholders (the latter suppressed by
   * `shadowBodyExists` when a body already exists at `root`). Content body files
   * are NOT touched — the caller copies edited bodies and leaves inherited bodies
   * in place. Used by `CanonicalStore` to rebuild the canonical skeleton from the
   * effective merge instead of copying a proposal's frozen snapshot wholesale.
   */
  static async persistNodesToRoot(
    docPath: DocPath,
    nodes: SkeletonNode[],
    root: string,
    shadowBodyExists?: (bodyFilePath: string) => Promise<boolean>,
  ): Promise<void> {
    const skeleton = DocumentSkeletonInternal.fromNodes(docPath, nodes, root, shadowBodyExists);
    await skeleton.persistSkeletonTree();
  }

  /**
   * Proposal first-edit canonical initialization: when the first proposal-local
   * edit targets a document inherited from canonical (the proposal root has no
   * skeleton yet, but the effective document is live via canonical fallback),
   * persist the inherited structure into the proposal root so the proposal owns a
   * skeleton for the document the subsequent body write attaches to.
   *
   * This is the mechanism the proposal write implementation
   * (`ProposalShadowContentLayer.ensureProposalSkeletonForWrite`) invokes — it is
   * not a generic "flush" and makes no structural change; it materializes the
   * canonical structure verbatim.
   *
   * Idempotent and fallback-preserving: a no-op when the proposal root already
   * has a skeleton or tombstone, and a no-op for an empty skeleton. It delegates
   * to `persistSkeletonTree()`, so `writeTree()`'s placeholder suppression applies
   * — materialization never shadows non-empty canonical body files for untouched
   * nested parents (canonical body fallback is preserved).
   */
  async materializeInheritedSkeletonFromCanonical(): Promise<void> {
    // No-op when the proposal root already has a marker (skeleton or tombstone),
    // read directly from disk via the single-root primitives. Also a no-op for an
    // empty skeleton (nothing inherited to materialize).
    if (await skeletonFileExists(this.docPath, this.overlayRoot)) return;
    if (await tombstoneFileExists(this.docPath, this.overlayRoot)) return;
    if (this.roots.length === 0) return;
    await this.persistSkeletonTree();
  }
}

// ─── Tree construction from disk ─────────────────────────────────

/**
 * Manifest-overlay effective structure (Step 2).
 *
 * A proposal is a sparse, manifest-scoped overlay: it owns only the sections in
 * its `targets[]`/`sections` manifest; every other section is inherited from
 * *current* canonical. So the effective structure of a proposal read is NOT the
 * proposal skeleton wholesale (a frozen snapshot that would drop sections
 * canonical gained after the proposal opened) — it is current canonical MERGED
 * with the proposal's sparse structural changes:
 *
 *   - body-only proposal (no overlay skeleton)  → pure canonical structure;
 *   - structural proposal (overlay skeleton)    → overlay is the spine
 *     (created / renamed / moved / leveled sections + edited sections, deleted
 *     sections absent), and every canonical section the spine does NOT carry is
 *     inherited at its canonical-relative position — UNLESS this proposal DELETED
 *     it (its `sectionFile` id is in the proposal's `deleted_section_files` set,
 *     so it is dropped).
 *
 * There is no wholesale-overlay path (U5): the ONLY non-merge read is canonical
 * itself (`overlayRoot === canonicalRoot`). A proposal-overlay read with no
 * deleted-ids provider is an error, not a silent wholesale fallback.
 *
 * Section identity is the `sectionFile` id, which a structural overlay preserves
 * for inherited sections (it derives from canonical), so id-matching is sound:
 * an overlay id absent from canonical was created by the proposal; a canonical id
 * absent from the overlay was either deleted (its id is in the deleted set) or
 * added to canonical after the proposal opened (inherited). Keying the delete on
 * the stable id — not the heading path — means a delete needs no re-pathing when
 * an ancestor is renamed or moved (D4 / identity-based delete detection).
 */
/**
 * Manifest-overlay (Step 5a): the effective merged node tree (current canonical
 * overlaid by a proposal's sparse structural changes, claimed-but-absent =
 * deleted). Exposed for `CanonicalStore` absorb, which persists this tree as the
 * new canonical skeleton instead of copying the proposal's frozen snapshot.
 */
export async function resolveEffectiveSkeletonNodes(
  docPath: DocPath,
  overlayRoot: string,
  canonicalRoot: string,
  deletedSectionFiles?: ReadonlySet<string>,
): Promise<SkeletonNode[]> {
  return buildSkeletonTree(docPath, overlayRoot, canonicalRoot, deletedSectionFiles);
}

async function buildSkeletonTree(
  docPath: DocPath,
  overlayRoot: string,
  canonicalRoot: string,
  deletedSectionFiles?: ReadonlySet<string>,
): Promise<SkeletonNode[]> {
  const overlayPath = resolveSkeletonPath(docPath, overlayRoot);
  const canonicalPath = resolveSkeletonPath(docPath, canonicalRoot);

  // The ONLY non-merge path (U5): reading canonical itself (`overlayRoot ===
  // canonicalRoot`). Read the single root wholesale.
  if (overlayRoot === canonicalRoot) {
    if (!(await pathExists(canonicalPath))) return [];
    return readTreeRecursive(canonicalPath);
  }

  // U5: ONE law for every proposal-overlay read (`overlayRoot !== canonicalRoot`) —
  // it merges current canonical with the proposal's deleted-section-file id set
  // (D4: deletes are keyed by stable `sectionFile` id, NOT heading path, so a
  // delete survives ancestor rename/move without re-pathing). A missing provider
  // is a wiring omission, never a silent wholesale fallback — fail loud so "no
  // merge" can never happen by omission again (01 §3 "Manifest-scoped overlay
  // (universal)"; CLAUDE.md error policy). `loadDeletedSectionFiles` always returns
  // a set (no deletes is `new Set()`, not `undefined`), so `undefined` here means
  // no provider.
  if (deletedSectionFiles === undefined) {
    throw new Error(
      `Proposal-overlay structure read for "${docPath}" (overlay "${overlayRoot}" ≠ canonical ` +
        `"${canonicalRoot}") arrived with no deleted-section-files provider. Every overlay read must ` +
        `merge current canonical with the proposal's deleted-id set; wire a deletedSectionFilesProvider ` +
        `(ProposalReader / ProposalShadowContentLayer) — there is no wholesale fallback.`,
    );
  }

  // Effective-load fallback resolution: a proposal tombstone shadows canonical
  // as an empty (pending-deletion) document.
  if (await fileExists(resolveTombstonePath(docPath, overlayRoot))) {
    return [];
  }

  const canonicalNodes = (await pathExists(canonicalPath))
    ? await readTreeRecursive(canonicalPath)
    : [];

  // Body-only (sparse) proposal: no overlay skeleton → structure is fully
  // inherited from current canonical (the trivial merge: nothing claimed
  // structurally).
  if (!(await pathExists(overlayPath))) {
    return canonicalNodes;
  }

  const overlayNodes = await readTreeRecursive(overlayPath);

  // No canonical to inherit (proposal-created document) → overlay is the whole
  // structure.
  if (canonicalNodes.length === 0) return overlayNodes;

  return mergeEffectiveSkeleton(canonicalNodes, overlayNodes, deletedSectionFiles);
}

/** Collect every `sectionFile` id in a node forest (all nesting levels). */
function collectSectionFileIds(nodes: SkeletonNode[], out: Set<string>): void {
  for (const node of nodes) {
    out.add(node.sectionFile);
    if (node.children.length > 0) collectSectionFileIds(node.children, out);
  }
}

/**
 * Merge current-canonical structure with a structural proposal's overlay
 * (the spine), inheriting canonical sections the spine does not carry. See
 * `buildSkeletonTree`'s doc comment for the model.
 */
function mergeEffectiveSkeleton(
  canonicalNodes: SkeletonNode[],
  overlayNodes: SkeletonNode[],
  deletedSectionFiles: ReadonlySet<string>,
): SkeletonNode[] {
  const spineIds = new Set<string>();
  collectSectionFileIds(overlayNodes, spineIds);
  return mergeSiblings(canonicalNodes, overlayNodes, deletedSectionFiles, spineIds);
}

function mergeSiblings(
  canonicalSibs: SkeletonNode[],
  overlaySibs: SkeletonNode[],
  deletedSectionFiles: ReadonlySet<string>,
  spineIds: ReadonlySet<string>,
): SkeletonNode[] {
  const canonById = new Map<string, SkeletonNode>();
  for (const c of canonicalSibs) canonById.set(c.sectionFile, c);

  // 1. Lay down the overlay order (the proposal's intended structure). For a
  //    section the overlay shares with canonical (same id), recurse to merge
  //    deeper inherited descendants; an overlay-only id is proposal-created and
  //    keeps its overlay subtree verbatim.
  const result: SkeletonNode[] = [];
  for (const o of overlaySibs) {
    const c = canonById.get(o.sectionFile);
    if (c) {
      result.push({
        ...o,
        children: mergeSiblings(c.children, o.children, deletedSectionFiles, spineIds),
      });
    } else {
      result.push(o);
    }
  }

  // 2. Splice in canonical sections the spine does NOT carry anywhere
  //    (inherited), at their canonical-relative position — unless this proposal
  //    DELETED them. The delete check is keyed on the stable `sectionFile` id
  //    (D4 / identity-based delete detection), so a delete survives any ancestor
  //    rename/move without re-pathing — paths move, ids do not.
  for (let i = 0; i < canonicalSibs.length; i++) {
    const c = canonicalSibs[i];
    if (spineIds.has(c.sectionFile)) continue; // represented in the spine (possibly moved)
    if (deletedSectionFiles.has(c.sectionFile)) continue; // deleted by this proposal (by id)
    if (isBodyHolderShape(c) && result.some((r) => isBodyHolderShape(r))) {
      // Never produce a second body holder at a level — the spine's wins.
      continue;
    }
    const pos = canonicalInsertPosition(result, canonicalSibs, i);
    result.splice(pos, 0, c);
  }

  return result;
}

/**
 * Resolve where to splice an inherited canonical sibling into the merged result:
 * immediately after its nearest preceding canonical sibling that is present in
 * `result`; front of the list if none precede it.
 */
function canonicalInsertPosition(
  result: SkeletonNode[],
  canonicalSibs: SkeletonNode[],
  i: number,
): number {
  for (let j = i - 1; j >= 0; j--) {
    const prevId = canonicalSibs[j].sectionFile;
    const idx = result.findIndex((r) => r.sectionFile === prevId);
    if (idx >= 0) return idx + 1;
  }
  return 0;
}

/**
 * Recursively read a skeleton file and discover children from sub-skeleton files.
 *
 * All entries in a single skeleton file are SIBLINGS — nesting is represented
 * by the file system (sub-skeleton files in .sections/ directories), NOT by
 * heading level numbers within a file.
 */
async function readTreeRecursive(skeletonPath: string): Promise<SkeletonNode[]> {
  const content = await readFileIfExists(skeletonPath);
  if (content === null) return []; // File doesn't exist — no entries

  const entries = parseSkeletonToEntries(content);
  if (entries.length === 0) return [];

  const sectionsDir = `${skeletonPath}.sections`;
  const nodes: SkeletonNode[] = [];

  for (const entry of entries) {
    const node: SkeletonNode = {
      heading: entry.heading,
      headingLevel: entry.headingLevel,
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
 * Read the skeleton tree at EXACTLY one root, with no overlay/canonical
 * fallback merging. Returns null when the skeleton file at `root` does not
 * exist; otherwise returns a flat, document-order list of entries.
 *
 * Use this to observe one storage layer independently (e.g., diagnostics
 * comparing canonical-only and overlay-only structures) when you need flat
 * entries. For a single-root read that returns a full `DocumentSkeleton`, use
 * `DocumentSkeleton.fromSingleRoot(docPath, root)` — never the
 * `fromDisk(docPath, root, root)` trick, which drives the effective-load
 * (overlay-fallback-to-canonical) factory in a mode it was not designed for and
 * has been a historical source of bugs.
 */
export async function listSkeletonEntriesAtRoot(
  docPath: DocPath,
  root: string,
): Promise<FlatEntry[] | null> {
  const skeletonPath = resolveSkeletonPath(docPath, root);
  if (!(await pathExists(skeletonPath))) return null;
  const rootNodes = await readTreeRecursive(skeletonPath);
  const out: FlatEntry[] = [];
  const walk = (nodes: SkeletonNode[], parentPath: string[], parentSkeletonPath: string): void => {
    const sectionsDir = `${parentSkeletonPath}.sections`;
    for (const node of nodes) {
      const isBfh = isBodyHolderShape(node);
      const headingPath = isBfh ? [...parentPath] : [...parentPath, node.heading];
      const absolutePath = path.join(sectionsDir, node.sectionFile);
      const isSubSkeleton = node.children.length > 0;
      out.push({
        heading: node.heading,
        headingLevel: node.headingLevel,
        sectionFile: node.sectionFile,
        headingPath,
        absolutePath,
        isSubSkeleton,
      });
      if (isSubSkeleton) walk(node.children, headingPath, absolutePath);
    }
  };
  walk(rootNodes, [], skeletonPath);
  return out;
}

/**
 * Validate that a skeleton has at most one root entry (level=0, heading="")
 * at the top level. Duplicate roots represent an impossible state that causes
 * data loss on re-normalization. Throws immediately rather than letting the
 * corruption cascade.
 */
function validateNoDuplicateRoots(nodes: SkeletonNode[], docPath: DocPath): void {
  const rootCount = nodes.filter(n => isBodyHolderShape(n)).length;
  if (rootCount > 1) {
    throw new Error(
      `Skeleton integrity error: ${rootCount} duplicate root entries (headingLevel=0, heading="") ` +
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
      const hasBodyHolder = node.children.some(c => isBodyHolderShape(c));
      if (!hasBodyHolder) {
        const rootFile = generateSectionBodyFilename();
        node.children.unshift({
          heading: "",
          headingLevel: HeadingLevel.beforeFirstHeading,
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
  readonly docPath: DocPath;
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
function validateMutationPlan(plan: StructuralMutationPlan, docPath: DocPath): void {
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
