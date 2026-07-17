/**
 * ContentLayer — Uniform interface for reading/writing section content
 * from a content root directory.
 *
 * Constructed from a single contentRoot path and used for canonical-only
 * reads/writes. Proposal-shadow (overlay+canonical) behavior lives in
 * ProposalShadowContentLayer.
 */

import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  DocumentSkeleton,
  DocumentSkeletonInternal,
  resolveSkeletonPath,
  skeletonFileExists,
  tombstoneFileExists,
  writeTombstoneMarker,
  generateSectionFilename,
  generateBeforeFirstHeadingFilename,
  headingsEqual,
  listSkeletonEntriesAtRoot,
  type ContentEntry,
  type FlatEntry,
  type ProposalDocumentState,
  type SkeletonNode,
  type StructuralMutationPlan,
} from "./document-skeleton.js";
import { normalizeDocPath } from "./path-utils.js";
import { pathExists } from "./fs-primitives.js";
import { staleHeadingPath } from "./skeleton-errors.js";
// ParsedDocument was previously imported here for the document-replacement
// engine in the old `replaceDocumentFromMarkdown(...)`. Item 355 reduced that
// method to a thin wrapper over the section upsert core, so this
// module no longer needs the import. The parser is invoked deeper in the
// upsert path via `getParser()` (markdown-parser.js) and through the
// `ProposalShadowContentLayer.rewriteSubtreeFromParsedMarkdown(...)` machinery.
import type { DocStructureNode } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { bodyFromDisk, bodyFromParser, stripHeadingFromFragment, buildFragmentContent, assembleFragments, fragmentFromBodyHolder, stripLeadingNewlines, appendToBody, fragmentFromExternalContent, type SectionBody, type FragmentContent, type SectionBodyWithPotentialSubsections } from "./section-formatting.js";
import { isBodyHolderShape, isDocumentBeforeFirstHeading, parsedSectionIsHeadless } from "./section-shape.js";
import type { ParsedSection } from "./markdown-sections.js";

/**
 * Write a section body file, creating parent directories as needed.
 * No-op for sub-skeleton entries (their files are skeleton listings, not body content).
 *
 * All content is normalized via a markdownToJSON→jsonToMarkdown round-trip
 * before writing to disk. This is the single normalization gate — every
 * write path (MCP write_section, upsertDocumentFromMarkdown, upsertSection,
 * moveSection, renameSection, crash recovery) passes through here.
 *
 * The CRDT flush path (LiveFragmentStringsStore → markdown extraction) inherently normalizes
 * as a side-effect of Y.Doc→markdown serialization via jsonToMarkdown, so
 * content from that path is already normalized — the second pass here is a
 * no-op because the round-trip is idempotent. This double-application is
 * unavoidable because extractMarkdown cannot produce markdown without
 * jsonToMarkdown (it's the serialization step, not an optional normalization),
 * and we cannot skip normalization here because all other write paths do not
 * normalize. The arbitrary-markdown upsert paths (`ProposalShadowContentLayer.upsertSection(...)`
 * and the `upsertDocumentFromMarkdown(...)` wrapper that delegates to the core) parse
 * via the CommonMark parser for structural splitting but do not run the
 * milkdown serializer round-trip, so normalization here is genuinely
 * additive for that path.
 */
async function writeBodyFile(entry: ContentEntry | FlatEntry, content: string): Promise<void> {
  if ("kind" in entry) {
    if (entry.kind !== "content_entry") {
      throw new Error("writeBodyFile only accepts content entries.");
    }
  } else if (entry.isSubSkeleton) {
    return;
  }
  const normalized = jsonToMarkdown(markdownToJSON(content));
  await mkdir(path.dirname(entry.absolutePath), { recursive: true });
  await writeFile(entry.absolutePath, normalized, "utf8");
}

function resolveDocSkeletonPath(contentRoot: string, docPath: string): string {
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return path.resolve(contentRoot, ...normalized.split("/"));
}

function flatEntryFromContentEntry(entry: ContentEntry): FlatEntry {
  return {
    headingPath: [...entry.headingPath],
    heading: entry.heading,
    level: entry.level,
    sectionFile: entry.sectionFile,
    absolutePath: entry.absolutePath,
    isSubSkeleton: false,
  };
}

type ParsedMarkdownRewriteSection = Readonly<{
  heading: string;
  level: number;
  body: string;
  headingPath: readonly string[];
}>;

interface RewriteTreeNode extends SkeletonNode {
  children: RewriteTreeNode[];
}

function headingPathKey(headingPath: readonly string[]): string {
  return SectionRef.headingKey([...headingPath]);
}

/**
 * `targetParentPath: []` is reached ONLY from (a) a real top-level section
 * rewrite (`rewriteSubtreeFromParsedMarkdown` with `headingPath.length === 1`,
 * so `parentPath === []`), or (b) the explicit document-level whole-document
 * writes (`replaceWholeDocumentFromParsedMarkdown` /
 * `writeFreshDocumentFromParsedMarkdown`). It is NEVER reached from a
 * before-first-heading section write (`headingPath: []`): those are body-only
 * and routed through `writeSectionBodyVerbatim(...)`, so parsed BFH body
 * headings can never be promoted into root replacement nodes here.
 */
function buildRewriteReplacementRoots(
  targetParentPath: readonly string[],
  parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
  /**
   * WS-0 (split/merge survivor identity). Existing body-bearing content entries
   * of the subtree being rewritten, keyed by resulting heading-path key
   * (`headingPathKey([...targetParentPath, ...parsedHeadingPath])`) → their
   * existing `sectionFile`. A resulting section whose heading path ALREADY
   * existed reuses its existing `sectionFile` (so its `section::<id>` live
   * fragment key is preserved across the split), and only GENUINELY-NEW heading
   * paths mint a fresh id. When a surviving leaf becomes a sub-skeleton parent
   * (a child split out beneath it), its body moves to a body-holder child — so
   * the reused id is carried onto that pre-seeded body-holder, NOT the parent
   * structural node, because the live body fragment lives in the body-holder.
   */
  existingContentByResultingPath: ReadonlyMap<string, string> = new Map(),
): {
  replacementRoots: RewriteTreeNode[];
  bodyByResultingHeadingPath: Map<string, string>;
} {
  const replacementRoots: RewriteTreeNode[] = [];
  const bodyByResultingHeadingPath = new Map<string, string>();
  const nodesByParsedHeadingPath = new Map<string, RewriteTreeNode>();
  // Track each node's resulting heading-path key so we can decide id reuse
  // after the whole tree is built (a node's leaf-vs-parent shape is only known
  // once all its children have been attached).
  const resultingKeyByNode = new Map<RewriteTreeNode, string>();

  for (const section of parsedSections) {
    const parsedHeadingPath = [...section.headingPath];
    const parsedKey = headingPathKey(parsedHeadingPath);
    if (nodesByParsedHeadingPath.has(parsedKey)) {
      throw new Error(
        `Parsed markdown contains duplicate heading path [${parsedHeadingPath.join(" > ")}].`,
      );
    }

    const resultingHeadingPath = [...targetParentPath, ...parsedHeadingPath];
    const resultingKey = headingPathKey(resultingHeadingPath);

    const node: RewriteTreeNode = {
      heading: parsedHeadingPath.length === 0 ? "" : section.heading,
      level: section.level,
      // Provisional id; reconciled to the existing id below once leaf/parent
      // shape is known. BFH always mints a fresh BFH-family id.
      sectionFile: parsedHeadingPath.length === 0
        ? generateBeforeFirstHeadingFilename()
        : generateSectionFilename(section.heading),
      children: [],
    };
    nodesByParsedHeadingPath.set(parsedKey, node);
    resultingKeyByNode.set(node, resultingKey);

    bodyByResultingHeadingPath.set(resultingKey, section.body);

    if (parsedHeadingPath.length <= 1) {
      replacementRoots.push(node);
      continue;
    }

    const parentParsedHeadingPath = parsedHeadingPath.slice(0, -1);
    const parent = nodesByParsedHeadingPath.get(headingPathKey(parentParsedHeadingPath));
    if (!parent) {
      throw new Error(
        `Parsed markdown is structurally inconsistent: missing parent [${parentParsedHeadingPath.join(" > ")}] ` +
        `for section [${parsedHeadingPath.join(" > ")}].`,
      );
    }
    parent.children.push(node);
  }

  // WS-0: reconcile each node's id to the existing subtree where the heading
  // path is preserved. Done after the tree is fully built so we know whether a
  // surviving heading is a leaf (reuse on the node) or has gained children
  // (reuse on a pre-seeded body-holder, which is where the live body fragment
  // now lives).
  for (const [node, resultingKey] of resultingKeyByNode) {
    const existingFile = existingContentByResultingPath.get(resultingKey);
    if (existingFile === undefined) continue; // genuinely-new heading path → keep minted id
    if (node.children.length === 0) {
      // Survivor stays a leaf: keep its body fragment by reusing the id directly.
      node.sectionFile = existingFile;
    } else if (!node.children.some((c) => isBodyHolderShape(c))) {
      // Survivor became a sub-skeleton parent: its body moves to a body-holder.
      // Pre-seed that body-holder with the reused id so the live body fragment
      // key is preserved; the parent structural node keeps its minted id (no
      // live fragment points at a sub-skeleton parent). Pre-seeding here means
      // the later addBodyHoldersToParents pass sees a body-holder already present
      // and will not mint a competing one.
      node.children.unshift({ heading: "", level: 0, sectionFile: existingFile, children: [] });
    }
  }

  return { replacementRoots, bodyByResultingHeadingPath };
}

function buildBodyWritesForRewrite(
  docPath: string,
  added: FlatEntry[],
  bodyByResultingHeadingPath: Map<string, string>,
): StructuralMutationPlan["bodyWrites"] {
  const contentEntryByHeadingPath = new Map<string, FlatEntry>();
  for (const entry of added) {
    if (entry.isSubSkeleton) continue;
    const key = headingPathKey(entry.headingPath);
    if (contentEntryByHeadingPath.has(key)) {
      throw new Error(
        `Structural rewrite for "${docPath}" produced duplicate content entries at [${entry.headingPath.join(" > ")}].`,
      );
    }
    contentEntryByHeadingPath.set(key, entry);
  }

  if (contentEntryByHeadingPath.size !== bodyByResultingHeadingPath.size) {
    throw new Error(
      `Structural rewrite for "${docPath}" produced ${contentEntryByHeadingPath.size} content entries ` +
      `for ${bodyByResultingHeadingPath.size} parsed sections.`,
    );
  }

  const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
  for (const [headingKey, body] of bodyByResultingHeadingPath) {
    const entry = contentEntryByHeadingPath.get(headingKey);
    if (!entry) {
      throw new Error(
        `Structural rewrite for "${docPath}" could not resolve a body target for parsed heading key "${headingKey}".`,
      );
    }
    bodyWrites.push({ absolutePath: entry.absolutePath, content: body });
  }

  return bodyWrites;
}

export class SectionNotFoundError extends Error {}
export class DocumentNotFoundError extends Error {}
export class DocumentAssemblyError extends Error {}
export class MultiSectionContentError extends Error {}

/**
 * A rename/move would produce two same-parent siblings with the same heading
 * text at the same level. Ambiguous heading-path addressability under the
 * current model, so we reject the operation before it can be persisted. Guards
 * the direct skeleton-retitle primitives (`renameHeading`,
 * `retitleSubSkeletonParentInPlace`, `retitleSectionInPlace`) and the direct
 * `moveSubtree` primitive; not a global skeleton invariant.
 */
export class DuplicateSiblingHeadingError extends Error {
  readonly operation: "rename" | "move";
  readonly docPath: string;
  readonly parentHeadingPath: readonly string[];
  readonly proposedHeading: string;
  readonly proposedLevel: number;
  readonly conflictingSectionFile: string;
  readonly targetSectionFile: string;
  constructor(args: {
    operation: "rename" | "move";
    docPath: string;
    parentHeadingPath: readonly string[];
    proposedHeading: string;
    proposedLevel: number;
    conflictingSectionFile: string;
    targetSectionFile: string;
  }) {
    const parentLabel = args.parentHeadingPath.length === 0
      ? "the document root"
      : `[${args.parentHeadingPath.join(" > ")}]`;
    const verb = args.operation === "move" ? "move" : "rename";
    const destinationLabel = args.operation === "move" ? "destination" : "sibling list";
    super(
      `Cannot ${verb} section: ${destinationLabel} under ${parentLabel} already ` +
      `contains a sibling with heading "${args.proposedHeading}" at level ${args.proposedLevel} in ${args.docPath}.`,
    );
    this.name = "DuplicateSiblingHeadingError";
    this.operation = args.operation;
    this.docPath = args.docPath;
    this.parentHeadingPath = args.parentHeadingPath;
    this.proposedHeading = args.proposedHeading;
    this.proposedLevel = args.proposedLevel;
    this.conflictingSectionFile = args.conflictingSectionFile;
    this.targetSectionFile = args.targetSectionFile;
  }
}

/**
 * Reject an operation whose proposed heading/level would collide with an
 * existing same-parent sibling. Excludes the target's own `sectionFile` so a
 * no-op rename or same-location move does not self-trigger the guard.
 */
function assertNoDuplicateSiblingHeadingCollision(
  siblings: readonly SkeletonNode[],
  args: {
    operation: "rename" | "move";
    docPath: string;
    parentHeadingPath: readonly string[];
    targetSectionFile: string;
    proposedHeading: string;
    proposedLevel: number;
  },
): void {
  for (const sibling of siblings) {
    if (sibling.sectionFile === args.targetSectionFile) continue;
    if (sibling.level !== args.proposedLevel) continue;
    if (!headingsEqual(sibling.heading, args.proposedHeading)) continue;
    throw new DuplicateSiblingHeadingError({
      operation: args.operation,
      docPath: args.docPath,
      parentHeadingPath: args.parentHeadingPath,
      proposedHeading: args.proposedHeading,
      proposedLevel: args.proposedLevel,
      conflictingSectionFile: sibling.sectionFile,
      targetSectionFile: args.targetSectionFile,
    });
  }
}

export interface SectionDiscoveryEntry {
  heading: string;
  headingPath: string[];
  absolutePath: string;
  bodySizeBytes: number;
}

export interface UpsertSectionFromMarkdownDetailedResult {
  writtenEntries: FlatEntry[];
  removedContentEntries: FlatEntry[];
  fragmentKeyRemaps: StructuralMutationPlan["fragmentKeyRemaps"];
  liveReloadEntries: FlatEntry[];
  structureChanges: Array<{
    oldEntry: FlatEntry;
    newEntries: FlatEntry[];
  }>;
  /**
   * Removed entries including structural sub-skeleton nodes. Most callers need
   * only `removedContentEntries`; identity-based delete recording also needs a
   * collapsed parent's sub-skeleton id.
   */
  removedStructuralEntries?: FlatEntry[];
}

import { getParser } from "./markdown-parser.js";


export class ContentLayer {
  readonly contentRoot: string;

  constructor(contentRoot: string) {
    this.contentRoot = contentRoot;
  }

  /**
   * Return the document's structural tree as DocStructureNode[].
   * Suitable for API responses that describe document outline.
   */
  async getDocumentStructure(docPath: string): Promise<DocStructureNode[]> {
    const skeleton = await this.readSkeleton(docPath);
    return skeleton.structure;
  }

  /**
   * Return a flat ordered list of all sections in the document.
   * Suitable for callers that need to enumerate sections without
   * access to the raw DocumentSkeleton.
   */
  async getSectionList(docPath: string): Promise<Array<{ heading: string; level: number; sectionFile: string; headingPath: string[] }>> {
    const skeleton = await this.readSkeleton(docPath);
    const sections: Array<{ heading: string; level: number; sectionFile: string; headingPath: string[] }> = [];
    skeleton.forEachVisibleSection((heading, level, sectionFile, headingPath) => {
      sections.push({ heading, level, sectionFile, headingPath: [...headingPath] });
    });
    return sections;
  }

  /**
   * Return a flat document-order list of all skeleton entries under the
   * canonical root — sub-skeleton parents included, flagged via `isSubSkeleton`.
   * No overlay fallback is consulted. Returns `[]` when no canonical skeleton
   * file exists for `docPath`.
   *
   * Observational reader for callers that need to compare layers
   * independently (e.g., diagnostics). Goes through the sanctioned
   * single-root helper `listSkeletonEntriesAtRoot` — not the overlay-aware
   * `fromDisk` factory.
   */
  async listCanonicalEntries(docPath: string): Promise<FlatEntry[]> {
    const entries = await listSkeletonEntriesAtRoot(docPath, this.contentRoot);
    return entries ?? [];
  }

  /**
   * Return discovery rows for real sections only (no structural/sub-skeleton nodes).
   * Includes the canonical absolute body-file path and body file size in bytes.
   */
  async getSectionDiscoveryList(docPath: string): Promise<SectionDiscoveryEntry[]> {
    const skeleton = await this.readSkeleton(docPath);
    const baseEntries: Array<{ heading: string; headingPath: string[]; absolutePath: string }> = [];
    // forEachVisibleSection folds parent heading metadata onto nested body-holders
    // while keeping absolutePath pointed at the body-holder's body file — so
    // bodySizeBytes is still measured against the actual body file on disk.
    skeleton.forEachVisibleSection((heading, _level, _sectionFile, headingPath, absolutePath) => {
      baseEntries.push({
        heading,
        headingPath: [...headingPath],
        absolutePath,
      });
    });

    const sizedEntries = await Promise.all(
      baseEntries.map(async (entry) => {
        let bodySizeBytes = 0;
        try {
          const fileStat = await stat(entry.absolutePath);
          bodySizeBytes = fileStat.isFile() ? fileStat.size : 0;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        return {
          heading: entry.heading,
          headingPath: entry.headingPath,
          absolutePath: entry.absolutePath,
          bodySizeBytes,
        };
      }),
    );

    return sizedEntries;
  }

  /**
   * Read the canonical DocumentSkeleton for a document.
   */
  private async readSkeleton(docPath: string): Promise<DocumentSkeleton> {
    if (!(await skeletonFileExists(docPath, this.contentRoot))) {
      throw new DocumentNotFoundError(`No skeleton found for document: ${docPath}`);
    }
    return DocumentSkeleton.fromSingleRoot(docPath, this.contentRoot);
  }

  /**
   * Return all heading paths for a document.
   */
  async listHeadingPaths(docPath: string): Promise<string[][]> {
    const skeleton = await this.readSkeleton(docPath);
    const paths: string[][] = [];
    skeleton.forEachSection((_h, _l, _sf, headingPath) => {
      paths.push([...headingPath]);
    });
    return paths;
  }

  /**
   * Return the absolute path to the `.sections/` directory for a document.
   * Pure path computation — no disk read.
   */
  sectionsDirectory(docPath: string): string {
    return DocumentSkeleton.sectionsDir(docPath, this.contentRoot);
  }

  /**
   * Resolve a heading path to the absolute file path for its section body file.
   */
  async resolveSectionPath(docPath: string, headingPath: string[]): Promise<string> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      return skeleton.requireContentEntryByHeadingPath(headingPath).absolutePath;
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  /**
   * Resolve a heading path to its absolute file path and heading level.
   */
  async resolveSectionPathWithLevel(docPath: string, headingPath: string[]): Promise<{ absolutePath: string; level: number }> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      const entry = skeleton.requireContentEntryByHeadingPath(headingPath);
      return { absolutePath: entry.absolutePath, level: entry.level };
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  /**
   * Resolve a section file ID (e.g. "sec_abc123def") to its entry.
   */
  async resolveSectionFileId(docPath: string, sectionFileId: string): Promise<{ absolutePath: string; headingPath: string[]; level: number }> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      const entry = skeleton.requireEntryBySectionFileId(sectionFileId);
      return { absolutePath: entry.absolutePath, headingPath: entry.headingPath, level: entry.level };
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  /**
   * Read a single section's body content.
   *
   * Resolves (docPath, headingPath) → section file via the skeleton
   * and reads the file under this layer's contentRoot.
   */
  async readSection(ref: SectionRef): Promise<SectionBody> {
    const skeleton = await this.readSkeleton(ref.docPath);
    let entry: ContentEntry;
    try {
      entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }

    try {
      return bodyFromDisk(await readFile(entry.absolutePath, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      throw new SectionNotFoundError(
        `Section not found: (${ref.docPath}, [${ref.headingPath.join(" > ")}]).`,
      );
    }
  }

  /**
   * Read the full subtree rooted at headingPath: the section itself and all
   * descendants. Reads body content via readSection().
   *
   * `headingPath` must be non-empty. For whole-document enumeration use
   * `getSectionList(docPath)` + `readSection(...)`. For before-first-heading use
   * `readSection(ref(docPath, []))`.
   */
  async readSubtree(
    docPath: string,
    headingPath: string[],
  ): Promise<Array<{ headingPath: string[]; heading: string; level: number; bodyContent: string }>> {
    if (headingPath.length === 0) {
      throw new Error(
        `ContentLayer.readSubtree(${docPath}, []) is not allowed — use getSectionList(docPath) + readSection(...) for whole-document enumeration, or readSection(ref(docPath, [])) for before-first-heading.`,
      );
    }
    const skeleton = await this.readSkeleton(docPath);
    const entries = skeleton.subtreeEntries(headingPath);
    const result: Array<{ headingPath: string[]; heading: string; level: number; bodyContent: string }> = [];
    for (const entry of entries) {
      const bodyContent = await this.readSection(new SectionRef(docPath, entry.headingPath));
      result.push({ headingPath: entry.headingPath, heading: entry.heading, level: entry.level, bodyContent });
    }
    return result;
  }

  /**
   * Batch-read multiple sections, memoizing skeletons by docPath.
   *
   * Avoids redundant skeleton reads when reading many sections from the
   * same document. Returns a Map keyed by "docPath::heading>path".
   * Sections whose files are missing are silently omitted from the result.
   */
  async readSectionBatch(
    sections: SectionRef[],
  ): Promise<Map<string, string>> {
    const skeletonCache = new Map<string, DocumentSkeleton>();
    const result = new Map<string, string>();

    for (const ref of sections) {
      let skeleton = skeletonCache.get(ref.docPath);
      if (!skeleton) {
        skeleton = await this.readSkeleton(ref.docPath);
        skeletonCache.set(ref.docPath, skeleton);
      }

      const entry = skeleton.findContentEntryByHeadingPath(ref.headingPath);
      if (!entry) continue;

      try {
        const content = await readFile(entry.absolutePath, "utf8");
        result.set(ref.globalKey, content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    return result;
  }

  /**
   * STRICT internal section-body write primitive (item 229).
   *
   * NOT the ordinary caller-facing API for user-authored markdown.
   * The new caller-facing surface is
   * `ProposalShadowContentLayer.upsertSection(...)` (item 225); this
   * canonical `writeSection(...)` is the strict small primitive that
   * `upsertSection(...)` (and other internal callers) compose
   * over when they have ALREADY classified content as body-only.
   *
   * Contract:
   *   - Existing section only — throws if `ref.headingPath` is not in
   *     the skeleton (no auto-create, no ancestor materialization, no
   *     auto-document creation).
   *   - Body-only semantics — strips a leading heading at `entry.level`
   *     if it matches the target's heading text, then refuses any
   *     remaining embedded heading by throwing
   *     `MultiSectionContentError`.
   *   - Normalize-on-write — body is processed via
   *     `fragmentFromExternalContent(...)` + `stripHeadingFromFragment(...)`.
   *   - No structural side effects — never mutates the skeleton tree,
   *     never creates parents, never splits on embedded headings, never
   *     auto-creates the document.
   *
   * Callers that have arbitrary user-authored markdown and don't know
   * whether it contains embedded headings MUST use
   * `ProposalShadowContentLayer.upsertSection(...)` instead.
   */
  async writeSection(
    ref: SectionRef,
    content: string,
  ): Promise<void> {
    const skeleton = await this.readSkeleton(ref.docPath);
    const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
    // Enforce body-only invariant: strip leading heading if it matches the skeleton entry
    const body = stripHeadingFromFragment(fragmentFromExternalContent(content), entry.level);
    // Guard: reject multi-heading content — canonical writes must not mutate skeleton structure
    const hasHeadings = getParser().containsHeadings(body);
    if (hasHeadings) {
      throw new MultiSectionContentError(
        `Multi-section content passed to writeSection() for (${ref.docPath}, ` +
        `[${ref.headingPath.join(" > ")}]) — embedded heading(s) detected. ` +
        `Use ProposalShadowContentLayer.upsertSection(...) for arbitrary ` +
        `user markdown that may contain embedded headings; this strict primitive ` +
        `accepts body-only payloads only.`,
      );
    }
    await writeBodyFile(entry, body);
  }

  /**
   * Import a full assembled markdown document into this layer's proprietary format.
   *
   * Parses the markdown into sections, creates/updates the skeleton to match
   * the heading structure, and writes per-section body files. This is the
   * single authoritative normalize-on-write path for multi-section content.
   *
   * Returns the list of section targets (docPath + headingPath) for all
   * sections that were written, suitable for building proposal metadata.
   */
  /**
   * Read all sections for a canonical document.
   *
   * Returns Map keyed by headingKey (e.g. "Heading A>>Sub B").
   */
  async readAllSections(docPath: string): Promise<Map<string, SectionBody>> {
    const skeleton = await this.readSkeleton(docPath);
    const result = new Map<string, SectionBody>();
    const readTasks: Array<Promise<void>> = [];

    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath, absolutePath) => {
      readTasks.push(
        (async () => {
          const key = SectionRef.headingKey(headingPath);
          try {
            result.set(key, bodyFromDisk(await readFile(absolutePath, "utf8")));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            throw new DocumentAssemblyError(
              `Section "${key}" in document "${docPath}" is referenced by the skeleton but has no body file in the active layer. ` +
              `This indicates data corruption — the skeleton and section files are out of sync.`,
              { cause: err },
            );
          }
        })(),
      );
    });

    await Promise.all(readTasks);
    return result;
  }

  /**
   * Assemble a complete document from skeleton + section body files.
   *
   * Reads all non-sub-skeleton entries from the skeleton in document order
   * and concatenates their body content.
   */
  async readAssembledDocument(docPath: string): Promise<string> {
    const skeleton = await this.readSkeleton(docPath);

    // Collect body sections via the visible-section visitor (sync), then read files (async).
    // forEachVisibleSection folds nested body-holder children onto their sub-skeleton
    // parent's visible heading/level, so this loop renders `## Heading` + body for those
    // entries instead of treating them as anonymous BFH-style content.
    const bodyEntries: Array<{ heading: string; level: number; sectionFile: string; absolutePath: string; headingPath: string[] }> = [];
    skeleton.forEachVisibleSection((heading, level, sectionFile, headingPath, absolutePath) => {
      bodyEntries.push({ heading, level, sectionFile, absolutePath, headingPath: [...headingPath] });
    });

    if (bodyEntries.length === 0) {
      return "";
    }

    const parts: FragmentContent[] = [];

    for (const entry of bodyEntries) {
      let content: SectionBody | undefined;
      try {
        content = bodyFromDisk(await readFile(entry.absolutePath, "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        throw new DocumentAssemblyError(
          `Skeleton integrity check failed for "${docPath}": section file "${entry.sectionFile}" is referenced by the skeleton but has no body file in the active layer. This indicates data corruption.`,
          { cause: err },
        );
      }

      if (content === undefined) continue;

      if (isDocumentBeforeFirstHeading(entry)) {
        // Document-level BFH: body IS fragment content (strip leading newlines defensively).
        const trimmed = stripLeadingNewlines(content);
        if (trimmed) parts.push(fragmentFromBodyHolder(trimmed));
      } else {
        parts.push(buildFragmentContent(content, entry.level, entry.heading));
      }
    }

    return assembleFragments(...parts);
  }
}

// ─── ProposalShadowContentLayer ─────────────────────────────────

/**
 * ProposalShadowContentLayer — skeleton-aware content layer that shadows a
 * proposal content tree over the canonical content tree (overlay-first then
 * canonical fallback).
 *
 * @internal This is a private implementation detail of the proposal facades
 * (`ProposalReader` / `ProposalEditor`). Route handlers, MCP tools, CRDT
 * publication, and frontend proposal services MUST NOT import or instantiate
 * it directly — go through `ProposalReader` / `ProposalEditor` instead.
 *
 * Owns skeleton loading (overlay-first-then-canonical), structural mutation,
 * and content writes. Callers never see or touch DocumentSkeletonInternal.
 *
 * Per item 191: this class holds NO long-lived writable
 * `DocumentSkeletonInternal` instances. Every method that needs a writable
 * skeleton fresh-loads it via `DocumentSkeletonInternal.mutableFromDisk(...)`
 * (or `createEmptySkeletonInRoot(...)` for create flows). Same-call local
 * variables are allowed; cross-call memoization is not.
 */
export class ProposalShadowContentLayer {
  readonly overlayRoot: string;
  readonly canonicalRoot: string;
  /**
   * Identity-based delete detection (D4/D5): supplies the canonical section-file
   * IDS this proposal has DELETED for a document, so the effective-structure merge
   * can drop a deleted section by stable id (a delete then survives any ancestor
   * rename/move without re-pathing) while inheriting every other canonical
   * section. Injected by `ProposalReader`/`ProposalEditor` (which know the proposal
   * id). Absent for canonical-only constructions (`overlayRoot === canonicalRoot`)
   * and direct test constructions, where the merge degrades to "inherit all,
   * delete none" (strictly non-destructive).
   */
  private readonly deletedSectionFilesProvider?: (docPath: string) => Promise<ReadonlySet<string> | undefined>;

  constructor(
    overlayRoot: string,
    canonicalRoot: string,
    deletedSectionFilesProvider?: (docPath: string) => Promise<ReadonlySet<string> | undefined>,
  ) {
    this.overlayRoot = overlayRoot;
    this.canonicalRoot = canonicalRoot;
    this.deletedSectionFilesProvider = deletedSectionFilesProvider;
  }

  /**
   * True only for a live document. Missing and tombstoned documents return false.
   */
  async documentExists(docPath: string): Promise<boolean> {
    return (await this.getDocumentState(docPath)) === "live";
  }

  /**
   * Resolve the effective document state for this proposal content tree:
   * proposal tombstone wins, then a proposal skeleton, then a canonical
   * skeleton fallback, else missing.
   *
   * Document state is determined by skeleton/tombstone files only. The presence
   * or absence of a before-first-heading section has no effect on document
   * existence — a document with zero sections is valid and "live".
   *
   * This is a pure disk-state resolver composed from the single-root storage
   * primitives (`tombstoneFileExists` / `skeletonFileExists`). There is no
   * cache, no fast path, and no in-process memoization to second-guess.
   */
  async getDocumentState(docPath: string): Promise<ProposalDocumentState> {
    if (this.overlayRoot !== this.canonicalRoot && (await tombstoneFileExists(docPath, this.overlayRoot))) {
      return "tombstone";
    }
    if (await skeletonFileExists(docPath, this.overlayRoot)) return "live";
    if (await skeletonFileExists(docPath, this.canonicalRoot)) return "live";
    return "missing";
  }

  /**
   * Materializes a valid persisted live-empty document in the overlay (item 170).
   *
   * Semantic job: after a successful call, the overlay contains exactly an
   * empty skeleton file for `docPath` and nothing else — no body files, no
   * CRDT involvement, no extra writes. Subsequent callers can
   * safely add sections via `upsertSection(...)`.
   *
   * State policy (enforced here, not in the DS layer):
   *   - "missing"   → persist a new live-empty doc
   *   - "live"      → throw "already exists"
   *   - "tombstone" → throw "pending deletion" (resurrection NOT supported)
   *
   * Persistence is delegated to the single blessed factory
   * `DocumentSkeletonInternal.createEmptySkeletonInRoot(...)`.
   * Per item 197 the returned writable skeleton is intentionally NOT
   * stored on this instance — there is no class-level cache. Subsequent
   * methods that need a writable skeleton fresh-load via
   * `mutableFromDisk(...)`.
   */
  async createDocument(docPath: string): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state === "live") {
      throw new Error(`Cannot create document "${docPath}" — it already exists.`);
    }
    if (state === "tombstone") {
      throw new Error(`Cannot create document "${docPath}" — it is pending deletion in this proposal.`);
    }
    await DocumentSkeletonInternal.createEmptySkeletonInRoot(
      docPath,
      this.overlayRoot,
    );
  }


  /**
   * Pure fresh-load helper for an existing writable skeleton. Creates nothing,
   * memoizes nothing. Throws DocumentNotFoundError if the document does not
   * exist or is pending deletion.
   *
   * Every call resolves effective document state from disk and then loads a
   * single-root mutable skeleton via `loadWritableSkeleton(...)` — a pure read
   * with no implicit write side-effects. There is no cross-call cache. Hidden
   * materialization is NOT performed: the only sanctioned path for materializing
   * a missing document is `createDocument(...)`.
   */
  private async getWritableSkeleton(docPath: string): Promise<DocumentSkeletonInternal> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
    }
    return this.loadWritableSkeleton(docPath);
  }

  /**
   * Compose a single-root mutable skeleton for the proposal write path. DS is
   * single-root; the proposal subsystem owns the canonical fallback: the structure
   * is read from the proposal root when a proposal skeleton exists, else from
   * canonical (first-edit inherited structure); the instance is bound to the
   * proposal root (writes land there); and a `shadowBodyExists` policy is injected
   * so `writeTree` suppresses placeholders that would shadow non-empty canonical
   * bodies. Pure load — no writes.
   */
  private async loadWritableSkeleton(docPath: string): Promise<DocumentSkeletonInternal> {
    const structureRoot = (await skeletonFileExists(docPath, this.overlayRoot))
      ? this.overlayRoot
      : this.canonicalRoot;
    const nodes = await DocumentSkeletonInternal.loadNodesFromRoot(docPath, structureRoot);
    return DocumentSkeletonInternal.fromNodes(
      docPath,
      nodes,
      this.overlayRoot,
      (bodyFilePath) => this.canonicalBodyExists(bodyFilePath),
    );
  }

  /**
   * Shadow-body policy for `writeTree` placeholder suppression: true when a body
   * file already exists in canonical at the same relative path as the given
   * proposal-root body path. Single-layer (`overlayRoot === canonicalRoot`) → no
   * shadow, always false.
   */
  private async canonicalBodyExists(proposalBodyFilePath: string): Promise<boolean> {
    if (this.overlayRoot === this.canonicalRoot) return false;
    const rel = path.relative(this.overlayRoot, proposalBodyFilePath);
    return pathExists(path.join(this.canonicalRoot, rel));
  }

  private async readSkeleton(docPath: string): Promise<DocumentSkeleton> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
    }
    // Manifest-overlay (Step 2 / D4): the effective structure is current canonical
    // merged with this proposal's sparse overlay, with sections whose `sectionFile`
    // id is in the proposal's deleted-id set treated as deletes. Deleted ids come
    // from the injected provider; a canonical-only layer never merges.
    const deletedSectionFiles = this.overlayRoot !== this.canonicalRoot && this.deletedSectionFilesProvider
      ? await this.deletedSectionFilesProvider(docPath)
      : undefined;
    return DocumentSkeleton.fromDisk(docPath, this.overlayRoot, this.canonicalRoot, deletedSectionFiles);
  }

  /**
   * Return the document's structural tree as DocStructureNode[].
   * Uses proposal-then-canonical skeleton loading.
   */
  async getDocumentStructure(docPath: string): Promise<DocStructureNode[]> {
    const skeleton = await this.readSkeleton(docPath);
    return skeleton.structure;
  }

  /**
   * Resolve a section file ID to its entry.
   * Uses proposal-then-canonical skeleton loading.
   */
  async resolveSectionFileId(docPath: string, sectionFileId: string): Promise<{ absolutePath: string; headingPath: string[]; level: number; heading: string }> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      const entry = skeleton.requireEntryBySectionFileId(sectionFileId);
      return { absolutePath: entry.absolutePath, headingPath: entry.headingPath, level: entry.level, heading: entry.heading };
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  /**
   * Resolve a heading path to the absolute file path for its section body file.
   * Uses proposal-then-canonical skeleton loading.
   */
  async resolveSectionPath(docPath: string, headingPath: string[]): Promise<string> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      return skeleton.requireContentEntryByHeadingPath(headingPath).absolutePath;
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  /**
   * Resolve a heading path to its absolute file path and heading level.
   * Uses proposal-then-canonical skeleton loading.
   */
  async resolveSectionPathWithLevel(docPath: string, headingPath: string[]): Promise<{ absolutePath: string; level: number }> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      const entry = skeleton.requireContentEntryByHeadingPath(headingPath);
      return { absolutePath: entry.absolutePath, level: entry.level };
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  /**
   * Return all heading paths for a document.
   */
  async listHeadingPaths(docPath: string): Promise<string[][]> {
    const skeleton = await this.readSkeleton(docPath);
    const paths: string[][] = [];
    skeleton.forEachSection((_h, _l, _sf, headingPath) => {
      paths.push([...headingPath]);
    });
    return paths;
  }

  /**
   * Return the absolute path to the `.sections/` directory for a document.
   * Pure path computation — no disk read.
   */
  sectionsDirectory(docPath: string): string {
    return DocumentSkeleton.sectionsDir(docPath, this.overlayRoot);
  }

  /**
   * List all heading paths from canonical, then write a tombstone marker
   * to the overlay. Returns the heading paths (for building proposal metadata).
   *
   * Per item 178: heading enumeration and tombstone writing are deliberately
   * separated. Heading enumeration is a read against the canonical skeleton
   * (used by callers to build proposal metadata, e.g. "these are the
   * sections that will go away when this tombstone commits"). Tombstone
   * writing is delegated to `tombstoneDocumentExplicit(...)`, which is the
   * single sanctioned mutating tombstone path on `ProposalShadowContentLayer` —
   * the deleted readonly `DocumentSkeleton.createTombstone(...)` static is
   * gone. Per item 191 there is no class-level skeleton cache; nothing
   * to invalidate.
   */
  async tombstoneDocument(docPath: string): Promise<string[][]> {
    const skeleton = await DocumentSkeleton.fromSingleRoot(docPath, this.canonicalRoot);
    const paths: string[][] = [];
    skeleton.forEachSection((_h, _l, _sf, headingPath) => {
      paths.push([...headingPath]);
    });
    await this.tombstoneDocumentExplicit(docPath);
    return paths;
  }

  /**
   * Proposal-owned semantic document rename (todolist items 54–61). Mutates ONLY
   * this proposal's content tree — never canonical, never a live Y.Doc.
   *
   * Strict source state (item 55): a tombstoned or missing source rejects; a
   * proposal skeleton wins over canonical fallback; a canonical skeleton fallback
   * is a valid live source.
   *
   * Strict destination state (item 56): the new path must be absent in BOTH the
   * proposal and canonical — a proposal-live, canonical-live, or tombstoned
   * destination all reject (`getDocumentState` resolves tombstone→proposal→
   * canonical, so only `"missing"` means absent-in-both).
   *
   * Mechanics (items 57–59): write the destination from the EFFECTIVE source
   * skeleton, preserving source section-file IDs — the skeleton files are copied
   * verbatim (no markdown parse, no remint, not delete-then-recreate). Bodies are
   * copied by walking ONLY the skeleton-declared files (sub-skeleton structure
   * files AND section bodies), resolving each from the proposal first then the
   * canonical OLD path, and failing loudly if any declared file is missing. The
   * source `.sections/` tree is NOT copied recursively, so undeclared files never
   * appear under the destination.
   *
   * Atomicity (item 60): the old path is tombstoned as part of this same rename
   * mutation. Manifest derivation (old + new document targets + affected sections)
   * is owned by `mutateProposalContent`'s `rename_document` case.
   */
  async renameDocument(
    sourceDocPath: string,
    destinationDocPath: string,
  ): Promise<void> {
    // item 55: strict source state.
    const sourceState = await this.getDocumentState(sourceDocPath);
    if (sourceState === "tombstone") {
      throw new DocumentNotFoundError(`Cannot rename "${sourceDocPath}": pending deletion in this proposal.`);
    }
    if (sourceState === "missing") {
      throw new DocumentNotFoundError(`Cannot rename "${sourceDocPath}": document does not exist.`);
    }

    // item 56: strict destination state — must be absent in proposal AND canonical.
    const destinationState = await this.getDocumentState(destinationDocPath);
    if (destinationState !== "missing") {
      throw new Error(
        `Cannot rename "${sourceDocPath}" → "${destinationDocPath}": destination already exists (${destinationState}). ` +
        `The new path must be absent in both the proposal and canonical before a rename.`,
      );
    }

    // Effective source skeleton (proposal-first, canonical fallback): structure +
    // section-file IDs, with no markdown parse. Read-only — the rename only walks
    // it (`forEachNode`). Routed through `readSkeleton` so the claim-tracked merge
    // (current canonical ⊕ this proposal's manifest) governs it like every other
    // overlay read (U5) — never a provider-less wholesale fallback. Source state is
    // already validated live above, so the missing/tombstone guards are no-ops here.
    const sourceSkeleton = await this.readSkeleton(sourceDocPath);

    const overlaySrcSkeletonPath = resolveDocSkeletonPath(this.overlayRoot, sourceDocPath);
    const overlayDestSkeletonPath = resolveDocSkeletonPath(this.overlayRoot, destinationDocPath);
    const srcSectionsDir = `${overlaySrcSkeletonPath}.sections`;
    const destSectionsDir = `${overlayDestSkeletonPath}.sections`;

    // item 57: write the destination top skeleton file from the effective source
    // skeleton FILE verbatim (IDs preserved, no parse/remint).
    const topSkeleton = await this.readEffectiveSectionBody(overlaySrcSkeletonPath);
    if (topSkeleton === null) {
      throw new DocumentAssemblyError(
        `Rename source "${sourceDocPath}" is live but its skeleton file is missing in both layers.`,
      );
    }
    await mkdir(path.dirname(overlayDestSkeletonPath), { recursive: true });
    await writeFile(overlayDestSkeletonPath, topSkeleton, "utf8");

    // item 58/59: copy ONLY skeleton-declared files (sub-skeleton structure files
    // AND section bodies) under `.sections/`, resolving each from the proposal
    // first then the canonical old path, failing loudly on any missing declared
    // file. No recursive `.sections` copy → no undeclared/orphan files at dest.
    const declaredPaths: string[] = [];
    sourceSkeleton.forEachNode((_h, _l, _sf, _hp, absolutePath) => {
      declaredPaths.push(absolutePath);
    });
    for (const sourceAbsolutePath of declaredPaths) {
      const content = await this.readEffectiveSectionBody(sourceAbsolutePath);
      if (content === null) {
        throw new DocumentAssemblyError(
          `Rename "${sourceDocPath}" → "${destinationDocPath}": declared file ` +
          `"${path.relative(srcSectionsDir, sourceAbsolutePath)}" has no content in any layer ` +
          `(skeleton and section files are out of sync).`,
        );
      }
      const destPath = path.join(destSectionsDir, path.relative(srcSectionsDir, sourceAbsolutePath));
      await mkdir(path.dirname(destPath), { recursive: true });
      await writeFile(destPath, content, "utf8");
    }

    // item 60: tombstone the old path as part of the same rename mutation.
    await this.tombstoneDocumentExplicit(sourceDocPath);
  }

  async getSectionList(
    docPath: string,
  ): Promise<Array<{ heading: string; level: number; sectionFile: string; headingPath: string[] }>> {
    const skeleton = await this.readSkeleton(docPath);
    const sections: Array<{ heading: string; level: number; sectionFile: string; headingPath: string[] }> = [];
    skeleton.forEachVisibleSection((heading, level, sectionFile, headingPath) => {
      sections.push({ heading, level, sectionFile, headingPath: [...headingPath] });
    });
    return sections;
  }

  /**
   * Read every section body for a document using overlay-first then canonical
   * fallback (via `readEffectiveSectionBody`). Empty overlay files are returned as
   * empty bodies — see `readEffectiveSectionBody` for the overlay shadowing rule
   * (intentional vs structural-placeholder distinction is enforced at the
   * write site in `DocumentSkeletonInternal.writeTree`, not here).
   */
  async readAllSections(docPath: string): Promise<Map<string, SectionBody>> {
    const skeleton = await this.readSkeleton(docPath);
    const result = new Map<string, SectionBody>();
    const readTasks: Array<Promise<void>> = [];

    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath, absolutePath) => {
      readTasks.push(
        (async () => {
          const key = SectionRef.headingKey(headingPath);
          const content = await this.requireEffectiveSectionBody(absolutePath, docPath, key);
          result.set(key, bodyFromDisk(content));
        })(),
      );
    });

    await Promise.all(readTasks);
    return result;
  }

  private validateUpsertHeadingArgument(ref: SectionRef, heading: string): void {
    const targetingBfh = ref.headingPath.length === 0;
    const headingProvided = heading.trim().length > 0;
    if (targetingBfh && headingProvided) {
      throw new Error(
        `Illegal arguments: targeting the headingless root section but provided a heading.`,
      );
    }
    // Option A: the ONLY headingless live fragment is the document-level BFH
    // (`headingPath: []`). A sub-skeleton parent's body-holder now carries the
    // parent's real heading on the live snapshot, so a non-BFH target with an
    // empty heading is no longer a legal shape — it can only be a caller error.
    if (!targetingBfh && !headingProvided) {
      throw new Error(
        `Illegal arguments: targeting a headed section but missing the section heading.`,
      );
    }
  }

  async upsertSection(
    ref: SectionRef,
    heading: string,
    content: SectionBodyWithPotentialSubsections,
    opts?: { contentIsFullMarkdown?: boolean },
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    this.validateUpsertHeadingArgument(ref, heading);

    // ── BFH target (`headingPath: []`) — body-only write ──────────────
    //
    // `[]` selects the before-first-heading section's BODY and nothing
    // else. It is NOT a whole-document identity selector: the payload is
    // stored verbatim as the BFH body, so any markdown heading syntax it
    // contains stays literal text rather than being parsed into headed
    // sections (which would silently rewrite or destroy the document's real
    // structure). Whole-document structural writes have their own
    // document-level APIs (`upsertDocumentFromMarkdown(...)`), which never
    // travel through a section write.
    if (ref.headingPath.length === 0) {
      return await this.writeSectionBodyVerbatim(ref, content as unknown as SectionBody);
    }

    // Option A: a non-BFH target always carries a real heading (the body-holder
    // snapshot now reports the parent heading), and the validator above rejects an
    // empty heading here — so there is no nested-body-holder empty-heading branch.

    const parsed = getParser().parseDocumentMarkdown(content);
    const firstHeaded = parsed.find((sec) => !parsedSectionIsHeadless(sec));

    // ── Case A: payload already starts with the target heading ────────
    //
    // Either an explicit `contentIsFullMarkdown` caller (CRDT normalize)
    // or a body-only caller (MCP write_section / create_proposal) whose
    // content happens to begin with the target heading + body. In both
    // shapes the payload is already a valid full-fragment markdown for the
    // target subtree, so we hand it straight to the parser-driven core.
    // Wrapping it would either duplicate the heading at the same level
    // (fails the parser's uniqueness invariant) or churn the section's
    // level (re-mints the sectionFile id — item 440).
    if (firstHeaded && firstHeaded.heading === heading) {
      return await this.upsertSectionFromMarkdownCore(ref, content);
    }

    // ── Case B: contentIsFullMarkdown with mismatched / absent heading ─
    //
    // (B1) Caller said "this is full fragment markdown" but the payload's
    //      first heading doesn't match the declared target heading. That's
    //      a caller bug — fail loudly.
    // (B2) Caller said "this is full fragment markdown" and the payload
    //      has NO headings. The CRDT user has deleted the heading text;
    //      pass the raw content straight through to the core's
    //      delete-and-absorb branch (the `headedSections.length === 0`
    //      case lower down). Synthesizing a heading here would silently
    //      clobber the deletion intent.
    if (opts?.contentIsFullMarkdown) {
      if (firstHeaded && firstHeaded.heading !== heading) {
        throw new Error(
          `Illegal arguments: content heading "${firstHeaded.heading}" does not match explicit heading "${heading}".`,
        );
      }
      return await this.upsertSectionFromMarkdownCore(ref, content);
    }

    // ── Case C: body-only convenience ─────────────────────────────────
    //
    // The caller passed bare body content (possibly empty, possibly with
    // its own embedded sub-headings whose first heading doesn't match the
    // target). Wrap it in a heading marker at the target's actual level.
    // Item 440 — the level MUST come from the live skeleton, not from raw
    // heading-path depth, or we re-mint the sectionFile id on every
    // body-only write to a section whose level diverges from its depth
    // (e.g. an h3 hanging directly under root, or any new child of a
    // non-strict-staircase parent).
    const level = await this.resolveTargetHeadingLevel(ref);
    const markdown = content
      ? `${"#".repeat(level)} ${heading}\n\n${content}`
      : `${"#".repeat(level)} ${heading}`;
    return await this.upsertSectionFromMarkdownCore(ref, markdown);
  }

  /**
   * Store a section body VERBATIM for an existing section identity — the
   * topology-neutral write-through used by CRDT per-edit materialization and by
   * the `headingPath: []` (BFH) section-write contract.
   *
   * Contract:
   *   - The payload is NEVER parsed and NO topology is created. Embedded
   *     markdown heading syntax (e.g. "## Looks Like Heading", "### Sub") stays
   *     literal body text — it produces no headed sections, renames, or
   *     reorders. Structural promotion of a settled embedded heading is a
   *     separate, quiescence-time operation, never a per-keystroke side effect.
   *   - The target section's `sectionFile` id is PRESERVED (the body file is
   *     overwritten in place), so the `section::<id>` live fragment key / cursor
   *     identity survives the write.
   *   - BFH is not special: `[]` is just the before-first-heading identity and
   *     follows the same body write-through path as every other section.
   *
   * State policy mirrors `upsertSectionFromMarkdownCore`:
   *   - "tombstone" → throw (pending deletion).
   *   - "missing"   → auto-create the document, then write.
   *   - "live"      → write in place.
   *
   * Missing structure (the document's first edit, or a `[]` BFH slot that does
   * not exist yet) is materialized via `materializeAncestorHeadings(...)` — a
   * structural create with NO parsing — before the body is written. A
   * byte-identical body short-circuits to an empty-change result so a clean
   * re-write does not churn ids.
   */
  async writeSectionBodyVerbatim(
    ref: SectionRef,
    body: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const state = await this.getDocumentState(ref.docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${ref.docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await this.createDocument(ref.docPath);
    }

    let skeleton = await this.getWritableSkeleton(ref.docPath);
    if (!skeleton.has(ref.headingPath)) {
      await this.materializeAncestorHeadings(ref.docPath, ref.headingPath);
      skeleton = await this.getWritableSkeleton(ref.docPath);
    }
    const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);

    // Trailing-newline canonicalization only (the body is otherwise stored
    // exactly as authored); `bodyFromDisk` is the sanctioned boundary that
    // applies the same trim `writeOverlayBodyFile` will on the way to disk.
    const newBody = bodyFromDisk(body as unknown as string);
    const currentBody = bodyFromDisk(
      (await this.readEffectiveSectionBody(entry.absolutePath)) ?? "",
    );
    if ((currentBody as string) === (newBody as string)) {
      return {
        writtenEntries: [],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [],
        structureChanges: [],
      };
    }

    await this.writeOverlayBodyFile(ref.docPath, entry, newBody);
    return {
      writtenEntries: [flatEntryFromContentEntry(entry)],
      removedContentEntries: [],
      fragmentKeyRemaps: [],
      liveReloadEntries: [flatEntryFromContentEntry(entry)],
      structureChanges: [],
    };
  }

  /**
   * Quiescence-time reflection of a before-first-heading (BFH) split into the
   * proposal: a settled `## Heading` typed into the BFH body is promoted into a
   * real top-level section. The BFH body keeps only the pre-heading orphan; the
   * promoted heading section(s) are inserted at the FRONT of the document
   * (immediately after the BFH, before the first existing headed root), so all
   * existing sections and their `sectionFile` ids are preserved.
   *
   * This is the root-split counterpart of the parser-driven
   * `writeSection(headedPath, ..., {contentIsFullMarkdown})` reflection used for
   * section-splits. It exists because a `[]` write is body-only and cannot
   * itself promote structure. Idempotent: re-running with the same already-split
   * proposal layout is a no-op once the BFH body and roots already match.
   */
  async splitBeforeFirstHeadingPromotingHeadings(
    docPath: string,
    bfhFragmentMarkdown: string,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const parsed = getParser().parseDocumentMarkdown(bfhFragmentMarkdown);
    const hasOrphan = parsed.length > 0 && parsed[0].level === 0 && parsed[0].heading === "";
    const orphanBody = (hasOrphan ? (parsed[0].body as unknown as string) : "") as unknown as SectionBody;
    const headed = hasOrphan ? parsed.slice(1) : parsed;

    // No heading to promote → plain BFH body update (verbatim).
    if (headed.length === 0) {
      return await this.writeSectionBodyVerbatim(new SectionRef(docPath, []), orphanBody);
    }

    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await this.createDocument(docPath);
    }
    let skeleton = await this.getWritableSkeleton(docPath);
    if (!skeleton.has([])) {
      await this.materializeAncestorHeadings(docPath, []);
      skeleton = await this.getWritableSkeleton(docPath);
    }
    const bfhEntry = skeleton.requireContentEntryByHeadingPath([]);

    // Idempotency (item 23): if the first promoted heading already exists as a
    // top-level section, this split was already reflected by a prior attempt
    // whose live apply aborted on the pre-flight clock check. Re-inserting would
    // duplicate the section / churn ids — return an empty-change no-op so the
    // retry only re-drives the live reshape from the (already-split) layout.
    if (skeleton.findStructuralNodeByHeadingPath([headed[0].heading])) {
      return {
        writtenEntries: [],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [],
        structureChanges: [],
      };
    }

    const { replacementRoots, bodyByResultingHeadingPath } = buildRewriteReplacementRoots(
      [],
      headed,
      new Map(),
    );

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const bfhIdx = ctx.roots.findIndex((n) => isBodyHolderShape(n));
      if (bfhIdx < 0) {
        throw new Error(
          `Skeleton integrity error in ${docPath}: BFH expected at front of roots for split reflection.`,
        );
      }
      ctx.addBodyHoldersToParents(replacementRoots);
      ctx.roots.splice(bfhIdx + 1, 0, ...replacementRoots);

      const added: FlatEntry[] = [];
      for (const node of replacementRoots) {
        added.push(...ctx.flattenNode(node, [], ctx.resolveSkeletonPathFor([])));
      }
      const bodyWrites = buildBodyWritesForRewrite(docPath, added, bodyByResultingHeadingPath);
      // Trim the survivor: the BFH keeps only the pre-heading orphan body.
      bodyWrites.push({ absolutePath: bfhEntry.absolutePath, content: orphanBody as unknown as string });
      return { removed: [], added, bodyWrites, fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
    });

    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }

    const addedNonSub = plan.added.filter((e) => !e.isSubSkeleton);
    const writtenEntries = [...addedNonSub, flatEntryFromContentEntry(bfhEntry)];
    return {
      writtenEntries,
      removedContentEntries: [],
      fragmentKeyRemaps: [],
      liveReloadEntries: writtenEntries,
      structureChanges: [{
        oldEntry: flatEntryFromContentEntry(bfhEntry),
        newEntries: writtenEntries,
      }],
    };
  }

  /**
   * Resolve the heading level for a body-only `upsertSection` target. The
   * level synthesis can never use raw heading-path depth — depth and level
   * only coincide for a strict h1/h2/h3 staircase, and a depth-based marker
   * triggers the parser-driven core's level-mismatch rewrite path which
   * re-mints the sectionFile id (item 440).
   *
   * Resolution order:
   *   1. Existing entry → use its real level.
   *   2. New section under an existing ancestor → ancestor.level + remaining
   *      depth (mirrors `materializeAncestorHeadings`'s parent.level + 1
   *      cascade for the to-be-created intermediate ancestors).
   *   3. New section in a missing/tombstoned doc OR with no existing ancestor
   *      → depth-matching level. This matches `materializeAncestorHeadings`,
   *      which always creates fresh ancestor chains starting at level 1.
   */
  private async resolveTargetHeadingLevel(ref: SectionRef): Promise<number> {
    if ((await this.getDocumentState(ref.docPath)) !== "live") {
      return ref.headingPath.length;
    }
    const skeleton = await this.readSkeleton(ref.docPath);
    const existing = skeleton.findStructuralNodeByHeadingPath(ref.headingPath);
    if (existing) return existing.level;
    for (let i = ref.headingPath.length - 1; i >= 1; i--) {
      const ancestor = skeleton.findStructuralNodeByHeadingPath(ref.headingPath.slice(0, i));
      if (ancestor) return ancestor.level + (ref.headingPath.length - i);
    }
    return ref.headingPath.length;
  }

  async upsertSectionMergingToPrevious(
    ref: SectionRef,
    bodyContent: string,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    return await this.upsertSectionFromMarkdownCore(
      ref,
      bodyContent,
      { requireMergeToPrevious: true },
    );
  }

  private async upsertSectionFromMarkdownCore(
    ref: SectionRef,
    markdown: string,
    opts?: { requireMergeToPrevious?: boolean },
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    // `[]` is NOT a legal core target. A before-first-heading write is a
    // body-only write handled by `writeSectionBodyVerbatim(...)`, and a
    // whole-document structural write is a document-level operation
    // (`upsertDocumentFromMarkdown(...)`). The parser-driven core only ever
    // rewrites the subtree at a real (non-empty) heading path; routing `[]`
    // here would parse BFH body text into headed sections and silently
    // rewrite the entire document.
    if (ref.headingPath.length === 0) {
      throw new Error(
        `upsertSectionFromMarkdownCore called with headingPath=[] in ${ref.docPath}. ` +
        `A '[]' section write targets the before-first-heading body only — route it ` +
        `through writeSectionBodyVerbatim(...); whole-document writes use ` +
        `upsertDocumentFromMarkdown(...).`,
      );
    }
    const state = await this.getDocumentState(ref.docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${ref.docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await this.createDocument(ref.docPath);
    }
    let skeleton = await this.getWritableSkeleton(ref.docPath);
    if (!skeleton.has(ref.headingPath)) {
      await this.materializeAncestorHeadings(ref.docPath, ref.headingPath);
      skeleton = await this.getWritableSkeleton(ref.docPath);
    }

    // ── Item 367 — parser-driven dispatch ──────────────────────────────
    //
    // The previous body of this method ran a string-level "strip heading,
    // detect embedded headings, branch on hasHeadings" classifier that
    // misclassified clean leaf no-ops, heading renames, and heading
    // relocations as deletions or duplicate-heading errors. The new path
    // parses the payload first and dispatches purely on the parsed shape,
    // funneling all work through `rewriteSubtreeFromParsedMarkdown(...)`
    // (item 369 — orphan-aware) and `deleteSectionAndAbsorbOrphanBody(...)`.
    const parsedSections = getParser().parseDocumentMarkdown(markdown);

    // Split off the leading level-0 orphan, if any. The
    // orphan is content the user authored ABOVE their first heading; it
    // gets absorbed into the previous body-holder via the leadingOrphanBody
    // option on the rewrite primitive (item 369).
    const hasOrphan = parsedSections.length > 0
      && parsedSections[0].level === 0
      && parsedSections[0].heading === "";
    const leadingOrphanBody = (hasOrphan
      ? (parsedSections[0].body as unknown as string)
      : "") as SectionBody;
    const headedSections = hasOrphan ? parsedSections.slice(1) : parsedSections;

    if (opts?.requireMergeToPrevious && headedSections.length > 0) {
      throw new Error(
        `Illegal arguments: upsertSectionMergingToPrevious cannot target a headed section with headed markdown content.`,
      );
    }

    // No headed content at all → user emptied the section / replaced its
    // heading with body-only text. Check whether the target is a
    // sub-skeleton parent (has descendants). If so, route to
    // collapseParentAndAbsorbOrphanBody which preserves descendants and
    // reparents them. Otherwise fall through to the existing leaf-only
    // delete-and-absorb primitive.
    if (headedSections.length === 0) {
      const isParent = skeleton.subtreeEntries(ref.headingPath).length > 1;
      if (isParent) {
        return await this.collapseParentAndAbsorbOrphanBody(
          skeleton,
          ref.headingPath,
          leadingOrphanBody,
        );
      }
      return await this.deleteSectionAndAbsorbOrphanBody(
        skeleton,
        ref.headingPath,
        leadingOrphanBody,
      );
    }

    // ── Item 378 — children-preservation special case ─────────────────
    //
    // Sub-skeleton parents (entries whose SkeletonNode has real children)
    // with single-headed payloads must NOT route through the general
    // rewrite path: that path splices the parent and re-flattens from a
    // single childless replacement root, silently dropping the entire
    // descendant subtree. The CRDT fragment for a parent section ordinarily
    // contains only its OWN heading + body (children live in their own
    // fragments), so this fires on plain body edits and heading renames
    // of any parent section.
    //
    // The cardinality-based detection: subtreeEntries(headingPath) excludes
    // sub-skeleton structural nodes and returns one entry for a leaf and
    // multiple entries for a parent (its body holder + each descendant
    // content section).
    const targetIsSubSkeletonParent =
      skeleton.subtreeEntries(ref.headingPath).length > 1;
    if (headedSections.length === 1 && targetIsSubSkeletonParent) {
      const single = headedSections[0];
      const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
      if (single.heading === entry.heading && single.level === entry.level) {
        // Body-only update on a sub-skeleton parent. requireContentEntryByHeadingPath
        // already collapsed to the body-holder child, so writing entry's
        // absolutePath updates the parent's own body without touching any
        // descendant section.
        await this.writeOverlayBodyFile(
          ref.docPath,
          entry,
          single.body as unknown as string,
        );
        return {
          writtenEntries: [flatEntryFromContentEntry(entry)],
          removedContentEntries: [],
          fragmentKeyRemaps: [],
          liveReloadEntries: [flatEntryFromContentEntry(entry)],
          structureChanges: [],
        };
      }
      // Heading text or level differs on a sub-skeleton parent. Preserve all
      // descendants by retitling the parent node in place (no sectionFile
      // remint), then write the parent body-holder content.
      const { oldEntry, newEntry } = await this.retitleSubSkeletonParentInPlace(
        skeleton,
        ref.docPath,
        ref.headingPath,
        single.heading,
        single.level,
      );
      await this.writeOverlayBodyFile(
        ref.docPath,
        newEntry,
        single.body as unknown as string,
      );
      return {
        writtenEntries: [flatEntryFromContentEntry(newEntry)],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [flatEntryFromContentEntry(newEntry)],
        structureChanges: [{
          oldEntry: flatEntryFromContentEntry(oldEntry),
          newEntries: [flatEntryFromContentEntry(newEntry)],
        }],
      };
    }

    // Temporary release guard: complex multi-heading rewrites for sub-skeleton
    // parents still run through the replacement-oriented rewrite path, which
    // does not preserve omitted descendants. Keep this rejected until the
    // diff-based subtree rewrite lands.
    if (targetIsSubSkeletonParent && headedSections.length > 1) {
      throw new Error(
        `Temporary limitation: upsertSection core cannot apply ` +
        `a multi-heading payload to sub-skeleton parent [${ref.headingPath.join(" > ")}] ` +
        `in ${ref.docPath} without risking descendant loss. Split the edit into ` +
        `single-heading parent edits and explicit child edits for now.`,
      );
    }

    // ── Item 371 — identity-upsert no-op short-circuit ────────────────
    //
    // Without this, the rewrite path mints fresh section file IDs on
    // every call (via buildRewriteReplacementRoots → generateSectionFilename),
    // causing a clean re-normalization to rename `timeline.md` →
    // `<new-id>.md`, bump the skeleton mtime, and churn every body file
    // in the subtree. The short-circuit restores the no-op property the
    // old body-only path had for free.
    //
    // The leadingOrphanBody === "" precondition is critical: a non-empty
    // orphan implies a predecessor modification, which is never identity.
    if (
      !hasOrphan
      && (await this.isIdentityUpsert(skeleton, ref.headingPath, headedSections))
    ) {
      return {
        writtenEntries: [],
        removedContentEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [],
        structureChanges: [],
      };
    }

    // ── Stable-target body-only edit (item 367 follow-up) ──────────────
    //
    // When the payload describes the SAME target heading + level (no
    // structural change) — possibly with a body delta and/or a leading
    // orphan to absorb — route through direct body writes instead of
    // the structural rewrite primitive. Routing through the rewrite
    // path here would mint a fresh section file id even though no
    // structural change exists, churning the fragment key and emitting
    // a misleading removed/added pair to the caller. This case is
    // disjoint from the children-preservation special case above
    // (which handles sub-skeleton parents) and from the identity
    // short-circuit (which already returned for the no-delta case).
    //
    // Atomicity note: only body files are touched here; the skeleton is
    // unchanged. The previous-body-holder append + target body write are
    // independent file operations and don't need to share a transaction.
    if (headedSections.length === 1 && !targetIsSubSkeletonParent) {
      const single = headedSections[0];
      const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
      if (single.heading === entry.heading && single.level === entry.level) {
        const writtenEntries: FlatEntry[] = [flatEntryFromContentEntry(entry)];
        const liveReloadEntries: FlatEntry[] = [flatEntryFromContentEntry(entry)];

        if (hasOrphan) {
          const prevHolder = skeleton.findPreviousBodyHolder(entry.sectionFile);
          if (prevHolder) {
            const existing = bodyFromDisk(
              await this.requireEffectiveSectionBody(prevHolder.absolutePath, ref.docPath, prevHolder.sectionFile),
            );
            const merged = appendToBody(existing, leadingOrphanBody);
            await this.writeOverlayBodyFile(
              ref.docPath,
              prevHolder,
              merged as unknown as string,
            );
            writtenEntries.push(prevHolder);
            liveReloadEntries.push(prevHolder);
          } else {
            // No previous body holder — orphan absorption requires
            // creating a BFH at the front of the document, which is a
            // structural mutation. Defer to the transaction-aware
            // rewrite primitive so the BFH creation and orphan write
            // are atomic with skeleton flush.
            return await this.rewriteSubtreeFromParsedMarkdown(
              ref.docPath,
              ref.headingPath,
              headedSections,
              { leadingOrphanBody },
            );
          }
        }

        await this.writeOverlayBodyFile(
          ref.docPath,
          entry,
          single.body as unknown as string,
        );

        return {
          writtenEntries,
          removedContentEntries: [],
          fragmentKeyRemaps: [],
          liveReloadEntries,
          structureChanges: [],
        };
      }
    }

    // Default path: rewrite the subtree from the parsed shape, with the
    // leading orphan absorbed atomically into the previous body-holder.
    return await this.rewriteSubtreeFromParsedMarkdown(
      ref.docPath,
      ref.headingPath,
      headedSections,
      { leadingOrphanBody },
    );
  }

  /**
   * Item 371 — identity-upsert no-op short-circuit.
   *
   * Returns true when the parsed payload describes the live subtree
   * exactly (heading text, level, and body bytes equal pairwise across
   * the inclusive subtree at `headingPath`). When true, the caller can
   * return an empty-change result instead of churning the subtree's
   * section file IDs through the rewrite path.
   *
   * `headingPath` MUST be a real (non-empty) heading path. `[]` is never an
   * identity-upsert target: a `[]` section write is a before-first-heading
   * body-only write (`writeSectionBodyVerbatim(...)`, which runs its own
   * byte-identity short-circuit against the BFH body alone), and a
   * whole-document identity check belongs to the document-level operations.
   * Comparing `[]` against `allContentEntries()` here would resurrect the
   * "`[]` is a whole-document selector" overload this invariant removes.
   *
   * Algorithm:
   *   1. Walk skeleton.subtreeEntries(headingPath) — the inclusive
   *      content subtree, excluding sub-skeleton structural nodes.
   *   2. Bail if cardinalities mismatch.
   *   3. For each parsed section, translate its parser-relative heading
   *      path to absolute by prepending headingPath.slice(0, -1), look up
   *      the live entry via findContentEntryByHeadingPath (which collapses
   *      sub-skeleton parents to their body holders while reporting the
   *      parent's own heading/level), and compare heading/level/body
   *      bytes. Any mismatch returns false.
   *
   * The body comparison reads via overlay+canonical fallback so a
   * canonical-only section (no overlay file yet) still byte-compares
   * correctly. Parser bodies are already trimmed/normalized by
   * `bodyFromParser`, and disk bodies are trimmed by `bodyFromDisk`, so
   * the comparison is between two trimmed strings — no trailing-newline
   * skew.
   */
  private async isIdentityUpsert(
    skeleton: DocumentSkeletonInternal,
    headingPath: string[],
    parsedSections: ReadonlyArray<ParsedSection>,
  ): Promise<boolean> {
    if (headingPath.length === 0) {
      throw new Error(
        `isIdentityUpsert called with headingPath=[] in ${skeleton.docPath}. ` +
        `BFH identity is checked against the BFH body alone in ` +
        `writeSectionBodyVerbatim(...); '[]' is never a whole-document ` +
        `identity selector here.`,
      );
    }
    if (parsedSections.length === 0) return false;

    const liveEntries = skeleton.subtreeEntries(headingPath);
    if (liveEntries.length !== parsedSections.length) return false;

    const parentPrefix = headingPath.slice(0, -1);
    for (const parsed of parsedSections) {
      const absoluteHeadingPath = [...parentPrefix, ...parsed.headingPath];
      const liveEntry = skeleton.findContentEntryByHeadingPath(absoluteHeadingPath);
      if (!liveEntry) return false;
      if (liveEntry.heading !== parsed.heading) return false;
      if (liveEntry.level !== parsed.level) return false;
      const liveBody = bodyFromDisk(
        (await this.readEffectiveSectionBody(liveEntry.absolutePath)) ?? "",
      );
      if ((liveBody as string) !== (parsed.body as unknown as string)) return false;
    }
    return true;
  }

  /**
   * Full-markdown creation of a document whose effective proposal state is
   * `missing` (todolist items 62–65). Composes EXISTING primitives only:
   * `createDocument(...)` produces a live-empty proposal document (and enforces
   * the missing-state precondition by rejecting `live`/`tombstone`), then
   * `writeFreshDocumentFromParsedMarkdown(...)` writes the parsed structure into
   * that empty document. The result is a self-contained proposal document tree
   * with no dependency on canonical body fallback. Manifest derivation is the
   * caller's `listHeadingPaths(...)` readback.
   */
  async createDocumentFromMarkdown(docPath: string, markdown: string): Promise<void> {
    await this.createDocument(docPath);
    const parsedSections = getParser().parseDocumentMarkdown(markdown);
    await this.writeFreshDocumentFromParsedMarkdown(docPath, parsedSections);
  }

  /**
   * Full-markdown overwrite of a document whose effective proposal state is
   * `live` (todolist items 67–75). The explicit replacement for the deleted
   * clear-then-fresh two-step — NOT a Y.Doc operation (writes only the proposal
   * content tree). Live-session handling for destructive overwrites stays at the
   * application layer (item 73); this primitive is session-agnostic.
   *
   * Implemented as a SINGLE atomic proposal content-tree mutation from a
   * (possibly non-empty) starting state via `replaceWholeDocumentFromParsedMarkdown`:
   * the markdown is parsed and the whole-document plan is built BEFORE any disk
   * write, so a parse/plan failure throws with the prior proposal state fully
   * intact. There is NO transient live-empty state — the skeleton is rewritten
   * directly old→new inside one `applyStructuralMutationTransaction`. Section IDs
   * are freshly minted (item 70).
   */
  async replaceDocumentFromMarkdown(docPath: string, markdown: string): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state !== "live") {
      throw new DocumentNotFoundError(
        state === "tombstone"
          ? `Document "${docPath}" is pending deletion in this proposal.`
          : `Document "${docPath}" does not exist.`,
      );
    }
    // Parse + build the replacement plan first; only then touch disk.
    const parsedSections = getParser().parseDocumentMarkdown(markdown);
    await this.replaceWholeDocumentFromParsedMarkdown(docPath, parsedSections);
  }

  /**
   * Atomic whole-document rewrite from a non-empty starting state (todolist item
   * 68). Removes ALL existing roots and adds the parsed replacement structure in
   * ONE `applyStructuralMutationTransaction` (the skeleton is persisted once),
   * then removes the proposal-tree section files no longer declared and writes
   * the new section bodies. No transient live-empty state is persisted.
   *
   * This is the non-empty counterpart of `writeFreshDocumentFromParsedMarkdown`;
   * the two share the same rewrite helpers (`buildRewriteReplacementRoots` /
   * `buildBodyWritesForRewrite`). `fragmentKeyRemaps` is intentionally empty: this
   * is a storage primitive, not a live reconciliation — the application layer
   * invalidates any live session separately (item 73).
   */
  private async replaceWholeDocumentFromParsedMarkdown(
    docPath: string,
    parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
  ): Promise<void> {
    const skeleton = await this.getWritableSkeleton(docPath);

    // Fresh-minted section-file IDs (no id-reuse map): whole-document overwrite
    // has no Y.Doc identity requirement (item 70).
    const { replacementRoots, bodyByResultingHeadingPath } = buildRewriteReplacementRoots(
      [],
      parsedSections,
    );

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const roots = ctx.findSiblingList([]);
      const parentSkeletonPath = ctx.resolveSkeletonPathFor([]);

      // Remove EVERY existing root (sub-skeleton parents + bodies).
      const removed: FlatEntry[] = [];
      for (const node of roots) {
        removed.push(...ctx.flattenNode(node, [], parentSkeletonPath));
      }

      // Replace the entire root list with the new structure.
      ctx.addBodyHoldersToParents(replacementRoots);
      roots.splice(0, roots.length, ...replacementRoots);

      const added: FlatEntry[] = [];
      for (const node of replacementRoots) {
        added.push(...ctx.flattenNode(node, [], parentSkeletonPath));
      }

      const bodyWrites = buildBodyWritesForRewrite(docPath, added, bodyByResultingHeadingPath);

      return {
        removed,
        added,
        bodyWrites,
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    // Remove proposal-tree section files no longer declared (item 68). With fresh
    // IDs the new files never collide with the removed ones.
    for (const entry of plan.removed) {
      if (entry.isSubSkeleton) {
        await rm(`${entry.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(entry.absolutePath, { force: true });
    }
    // Write the new section bodies through the guarded proposal body writer.
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
  }

  /**
   * Whole-document write-from-markdown dispatch (todolist item 71). Routes on the
   * effective proposal document state:
   *   - "missing"   → `createDocumentFromMarkdown(...)`
   *   - "live"      → `replaceDocumentFromMarkdown(...)`
   *   - "tombstone" → reject with `DocumentNotFoundError`
   *
   * Owns ONLY storage orchestration — no proposal creation, section metadata,
   * ACL, git trailers, or response shaping. Returns nothing; callers read back a
   * section-target list via `listHeadingPaths(...)`.
   */
  async upsertDocumentFromMarkdown(
    docPath: string,
    markdown: string,
  ): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      await this.createDocumentFromMarkdown(docPath, markdown);
    } else {
      await this.replaceDocumentFromMarkdown(docPath, markdown);
    }
  }

  // ─── Structural mutations ─────────────────────────────────

  // The private `createSection(...)` helper was deleted per item 434. It had
  // zero production callers (item 273 audit), zero remaining test callers
  // after item 430 migrated `insert-section-body-holder.test.ts` to drive
  // `upsertSection(...)`, and was a duplicate of the buggy
  // leaf→sub-skeleton transition path that item 432 fixed once-and-for-all
  // inside `materializeAncestorHeadings(...)`. All callers that previously
  // wanted "create a structural target then write a body" now go through
  // `ProposalShadowContentLayer.upsertSection(...)`.

  // ─── Read methods (delegated to readonly paths) ───────────

  async readSection(ref: SectionRef): Promise<SectionBody> {
    const skeleton = await this.readSkeleton(ref.docPath);
    const entry = skeleton.requireContentEntryByHeadingPath(ref.headingPath);
    const content = await this.readEffectiveSectionBody(entry.absolutePath);
    if (content === null) {
      throw new SectionNotFoundError(`Section not found in any layer for "${ref.docPath}" [${ref.headingPath.join(" > ")}]`);
    }
    return bodyFromDisk(content);
  }

  // ─── Private helpers ──────────────────────────────────────

  /**
   * Proposal-bound effective section-body reader. Given a resolved entry's
   * proposal body-file path, resolve the section's effective body:
   *   - a STAGED proposal body wins (the file exists under the proposal root) —
   *     and a staged EMPTY body is real content (that is how a user-cleared body
   *     is represented; it is never second-guessed at read time);
   *   - canonical body content is inherited ONLY when the proposal has no staged
   *     body for that section (the proposal file is absent);
   *   - `null` means absent in both layers.
   *
   * Proposal tombstone/delete ("absent") is enforced upstream: callers resolve
   * entries against the effective (tombstone-first) state before reading, so a
   * tombstoned document never reaches this reader. Body-holder placeholders are
   * suppressed at the WRITE site (`writeTree`), not here.
   */
  private async readEffectiveSectionBody(proposalBodyPath: string): Promise<string | null> {
    try {
      return await readFile(proposalBodyPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const canonicalPath = path.join(
      this.canonicalRoot,
      path.relative(this.overlayRoot, proposalBodyPath),
    );
    try {
      return await readFile(canonicalPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return null;
  }

  /**
   * Carry-forward body read: the section's body is about to be preserved into
   * another section (merge / absorb-orphan / collapse-parent). A missing body
   * file in BOTH layers is data corruption, so this throws rather than silently
   * substituting "" and losing the carried-forward content. Follows the
   * codebase's `require*` get-or-throw naming. Comparison / no-op reads that
   * legitimately tolerate an absent body keep `readEffectiveSectionBody(...) ?? ""`.
   */
  private async requireEffectiveSectionBody(
    proposalBodyPath: string,
    docPath: string,
    sectionLabel: string,
  ): Promise<string> {
    const content = await this.readEffectiveSectionBody(proposalBodyPath);
    if (content === null) {
      throw new DocumentAssemblyError(
        `Section "${sectionLabel}" in document "${docPath}" is referenced by the skeleton but has no body file in any layer. ` +
        `This indicates data corruption — the skeleton and section files are out of sync.`,
      );
    }
    return content;
  }

  /**
   * Write-path invariant gate: a real proposal body write must never target a
   * tombstoned or missing document. It does NOT materialize structure.
   *
   * Manifest-overlay model (Step 1): a body write to an inherited section must NOT
   * snapshot the whole canonical skeleton into the proposal. The writable skeleton
   * loaded for the write already resolves the target section's canonical
   * section-file id (the canonical-structure fallback in `loadWritableSkeleton`),
   * so the overlay body file keys to that same id and overlays canonical. The
   * proposal therefore stays sparse: a body-only edit creates no proposal skeleton
   * file — only the edited body file(s). Effective structure is resolved as
   * *current* canonical merged with the manifest at read time, not from a frozen
   * first-write snapshot.
   *
   * This is the proposal write implementation's own operation — it runs only on
   * write paths, never on reads.
   */
  private async ensureProposalSkeletonForWrite(docPath: string): Promise<void> {
    if (this.overlayRoot === this.canonicalRoot) return;
    if (await skeletonFileExists(docPath, this.overlayRoot)) return;

    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this proposal.`);
    }
    if (state === "missing") {
      throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
    }
  }

  /**
   * Proposal-native body-write guard: a section body may only be written for an
   * `entry` already resolved from the current proposal mutation context, and only
   * after the proposal skeleton for the document exists (the guard above runs
   * first, initializing it from canonical on the first inherited edit). There is
   * no path to write a body for an unresolved/arbitrary heading.
   */
  private async writeOverlayBodyFile(
    docPath: string,
    entry: ContentEntry | FlatEntry,
    content: string,
  ): Promise<void> {
    await this.ensureProposalSkeletonForWrite(docPath);
    await writeBodyFile(entry, content);
  }

  private async deleteSectionAndAbsorbOrphanBody(
    skeleton: DocumentSkeletonInternal,
    headingPath: string[],
    body: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const deletedEntry = skeleton.requireContentEntryByHeadingPath(headingPath);
    const deletion = await skeleton.deleteHeadingPreservingBody(headingPath);
    for (const removed of deletion.removed) {
      if (removed.isSubSkeleton) {
        await rm(`${removed.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(removed.absolutePath, { force: true });
    }
    for (const write of deletion.bodyWrites) {
      await this.writeOverlayBodyFile(
        skeleton.docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content as SectionBody,
      );
    }

    const orphanBody = stripLeadingNewlines(body);
    if ((orphanBody as string).trim()) {
      const existingMergeBody = bodyFromDisk(
        await this.requireEffectiveSectionBody(deletion.mergeTarget.absolutePath, skeleton.docPath, deletion.mergeTarget.sectionFile),
      );
      await this.writeOverlayBodyFile(
        skeleton.docPath,
        deletion.mergeTarget,
        appendToBody(existingMergeBody, orphanBody),
      );
    }

    return {
      writtenEntries: deletion.mergeTargetWasCreated || (orphanBody as string).trim()
        ? [deletion.mergeTarget]
        : [],
      removedContentEntries: deletion.removed.filter((e) => !e.isSubSkeleton),
      fragmentKeyRemaps: deletion.fragmentKeyRemaps,
      liveReloadEntries: deletion.mergeTargetWasCreated || (orphanBody as string).trim()
        ? [deletion.mergeTarget]
        : [],
      structureChanges: [{
        oldEntry: flatEntryFromContentEntry(deletedEntry),
        newEntries: [],
      }],
    };
  }

  /**
   * Collapse a parent heading: delete the target heading, reparent its
   * descendants under the previous heading, and merge the orphan body
   * into the merge target.
   *
   * This is the parent-aware companion to deleteSectionAndAbsorbOrphanBody.
   * While that method rejects sub-skeleton parents (which would lose
   * descendants), this method explicitly handles them:
   *
   *   1. Pre-reads all affected bodies by sectionFile.
   *   2. Calls skeleton.collapseParentHeading() to restructure the tree.
   *   3. Removes the target's sub-skeleton file and .sections/ dir.
   *   4. Writes reparented descendant bodies at their new absolutePaths.
   *   5. Merges the orphan body into the merge target.
   *   6. Returns the result with correct entries for live-fragment reconciliation.
   */
  private async collapseParentAndAbsorbOrphanBody(
    skeleton: DocumentSkeletonInternal,
    headingPath: string[],
    orphanBody: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const deletedEntry = skeleton.requireContentEntryByHeadingPath(headingPath);

    // Pre-read all bodies that will be relocated (keyed by sectionFile
    // so we can find them after the skeleton restructure changes absolutePaths).
    const subtreeEntries = skeleton.subtreeEntries(headingPath);
    const bodiesBySectionFile = new Map<string, string>();
    for (const entry of subtreeEntries) {
      if (entry.isSubSkeleton) continue;
      const content = await this.readEffectiveSectionBody(entry.absolutePath);
      if (content !== null) {
        bodiesBySectionFile.set(entry.sectionFile, content);
      }
    }

    // Pre-read the merge target's body BEFORE the collapse. The merge
    // target may transition from leaf to parent when promoted children are
    // reparented under it, causing persistSkeletonTree to overwrite its body
    // file with skeleton markers. Capturing the body now ensures it can
    // be restored to the new body-holder location afterward.
    const targetBH = subtreeEntries.find(e => isBodyHolderShape(e));
    let mergeTargetPreBody: string | null = null;
    let preMergeTargetSF: string | null = null;
    if (targetBH) {
      const preTarget = skeleton.findPreviousBodyHolder(targetBH.sectionFile);
      if (preTarget) {
        mergeTargetPreBody = await this.requireEffectiveSectionBody(preTarget.absolutePath, skeleton.docPath, preTarget.sectionFile);
        preMergeTargetSF = preTarget.sectionFile;
      }
    }

    // Restructure the skeleton.
    const collapse = await skeleton.collapseParentHeading(headingPath);

    // Remove the target's sub-skeleton file and its .sections/ directory.
    for (const removed of collapse.removed) {
      if (removed.isSubSkeleton) {
        await rm(`${removed.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(removed.absolutePath, { force: true });
    }

    // Write body-writes declared by the skeleton (e.g. empty BFH body).
    for (const write of collapse.bodyWrites) {
      await this.writeOverlayBodyFile(
        skeleton.docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content as SectionBody,
      );
    }

    // Write reparented descendant bodies at their new absolutePaths.
    const writtenEntries: FlatEntry[] = [];
    const liveReloadEntries: FlatEntry[] = [];

    for (const promoted of collapse.promotedEntries) {
      const body = bodiesBySectionFile.get(promoted.sectionFile);
      if (body !== undefined) {
        await this.writeOverlayBodyFile(
          skeleton.docPath,
          promoted,
          body as SectionBody,
        );
        writtenEntries.push(promoted);
        liveReloadEntries.push(promoted);
      }
    }

    // Merge orphan body into the merge target. Always use the pre-read
    // snapshot when available — persistSkeletonTree may have created an empty
    // body-holder file in the overlay that shadows the canonical version,
    // or may have overwritten the old leaf file with skeleton markers
    // (leaf-to-parent transition). Reading from disk after the collapse
    // would return empty in either case.
    const trimmedOrphan = stripLeadingNewlines(orphanBody);
    const hasOrphanContent = (trimmedOrphan as string).trim().length > 0;

    // The merge target body must be written whenever:
    // (a) it was just created (needs initial content), or
    // (b) orphan content needs to be appended, or
    // (c) the merge target had pre-existing content that persistSkeletonTree
    //     may have clobbered (pre-read is non-empty).
    const hasPreReadBody = mergeTargetPreBody !== null && mergeTargetPreBody.trim().length > 0;

    if (collapse.mergeTargetWasCreated || hasOrphanContent || hasPreReadBody) {
      const existingMergeBody = bodyFromDisk(mergeTargetPreBody ?? "");
      const finalBody = hasOrphanContent
        ? appendToBody(existingMergeBody, trimmedOrphan)
        : existingMergeBody;
      await this.writeOverlayBodyFile(
        skeleton.docPath,
        collapse.mergeTarget,
        finalBody,
      );
      liveReloadEntries.push(collapse.mergeTarget);
      writtenEntries.push(collapse.mergeTarget);
    }

    return {
      writtenEntries,
      removedContentEntries: collapse.removed.filter((e) => !e.isSubSkeleton),
      removedStructuralEntries: collapse.removed,
      fragmentKeyRemaps: collapse.fragmentKeyRemaps,
      liveReloadEntries,
      structureChanges: [{
        oldEntry: flatEntryFromContentEntry(deletedEntry),
        newEntries: [],
      }],
    };
  }

  /**
   * Public no-predecessor demotion primitive (WS-2, nested first-section →
   * BFH): delete a sub-skeleton PARENT heading that has NO preceding sibling,
   * moving its orphan body under an auto-created before-first-heading (BFH)
   * preamble and reparenting its descendants to top level KEEPING their
   * section-file ids (their live fragment keys / cursors survive). This is the
   * no-predecessor companion to `removeHeadingPreservingChildren`, which throws
   * when the target has no preceding sibling. Leaf (no-descendant) first
   * sections use the orphan→BFH leaf path instead; this method requires a
   * sub-skeleton parent (the underlying `collapseParentHeading` asserts it).
   */
  async collapseParentHeadingToBfh(
    docPath: string,
    headingPath: string[],
    orphanBody: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const skeleton = await this.getWritableSkeleton(docPath);
    return this.collapseParentAndAbsorbOrphanBody(skeleton, headingPath, orphanBody);
  }

  // (item 121) The private ensureAncestorHeadings(skeleton, headingPath)
  // helper has been removed — its only caller (writeSection) now uses the
  // explicit public materializeAncestorHeadings storage operation directly.

  // ─── Explicit caller-facing operations (items 55–63) ───
  //
  // Each of these methods is the new non-overloaded replacement for a
  // specific structural concern that the old DSInternal.replace() /
  // insertSectionUnder() primitives used to handle implicitly. They all
  // funnel mutation through DSInternal.applyStructuralMutationTransaction,
  // which guarantees the skeleton is persisted exactly once per operation
  // and returns a body-write/fragment-remap plan. Callers of the older
  // broken methods (deleteSection/moveSection/renameSection/etc.) migrate
  // to these over time — this class currently holds BOTH sets so the
  // compile-fail surface stays localized to the old methods' bodies.

  /**
   * Delete a subtree rooted at headingPath (the target section plus all
   * descendants). Writes the skeleton, removes the bodies declared in the
   * returned plan, and returns the list of removed FlatEntry records.
   *
   * headingPath=[] means "delete the before-first-heading section only" —
   * the document remains live with whatever non-BFH sections it still has.
   * Whole-document removal is a separate operation (tombstoneDocumentExplicit
   * below) and never takes a heading path.
   */
  async deleteSubtree(docPath: string, headingPath: string[]): Promise<FlatEntry[]> {
    const skeleton = await this.getWritableSkeleton(docPath);
    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      // BFH deletion: locate the level-0 root node (heading="") and remove it.
      if (headingPath.length === 0) {
        const bfhIdx = ctx.roots.findIndex((n) => isBodyHolderShape(n));
        if (bfhIdx < 0) {
          throw staleHeadingPath(docPath, headingPath, "no before-first-heading section to delete");
        }
        const bfhNode = ctx.roots[bfhIdx];
        const removed = ctx.flattenNode(bfhNode, [], resolveSkeletonPath(docPath, this.overlayRoot));
        ctx.roots.splice(bfhIdx, 1);
        return {
          removed,
          added: [],
          bodyWrites: [],
          fragmentKeyRemaps: removed.map((e) => ({ from: e.sectionFile, to: null })),
        } satisfies StructuralMutationPlan;
      }

      const parentPath = headingPath.slice(0, -1);
      const target = headingPath[headingPath.length - 1];
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot delete subtree");
      }
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removed = ctx.flattenNode(siblings[idx], parentPath, parentSkeletonPath);
      siblings.splice(idx, 1);
      return {
        removed,
        added: [],
        bodyWrites: [],
        fragmentKeyRemaps: removed.map((e) => ({ from: e.sectionFile, to: null })),
      } satisfies StructuralMutationPlan;
    });
    // Remove body files on disk for the removed subtree.
    for (const entry of plan.removed) {
      if (entry.isSubSkeleton) {
        await rm(`${entry.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(entry.absolutePath, { force: true });
    }
    return plan.removed;
  }

  /**
   * Rename a heading in place. Preserves all descendants and the target's
   * own body content. Always mints a fresh section file id — caller-side
   * body content is re-read and re-written under the new id as part of the
   * transaction plan.
   */
  async renameHeading(
    docPath: string,
    headingPath: string[],
    newHeading: string,
  ): Promise<ContentEntry> {
    if (headingPath.length === 0) {
      throw new Error(
        `Cannot rename the before-first-heading section in ${docPath} — it has no heading.`,
      );
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    const oldEntry = skeleton.requireContentEntryByHeadingPath(headingPath);
    const targetIsSubSkeletonParent = skeleton.subtreeEntries(headingPath).length > 1;

    // Temporary hotfix: preserve descendants by retitling sub-skeleton
    // parents in place (no sectionFile churn, no subtree body rewrites).
    if (targetIsSubSkeletonParent) {
      const { newEntry } = await this.retitleSubSkeletonParentInPlace(
        skeleton,
        docPath,
        headingPath,
        newHeading,
        oldEntry.level,
      );
      return newEntry;
    }

    // Read current body content BEFORE mutating so we can re-write it under
    // the new file id as part of the transaction.
    //
    // Per item 207: must use overlay+canonical-aware fallback. The previous
    // raw `readFile(oldEntry.absolutePath, ...)` against the overlay path
    // dropped body content for canonical-only sections (the overlay file
    // simply does not exist yet), causing rename to silently empty the
    // section.
    const oldBody = (await this.readEffectiveSectionBody(oldEntry.absolutePath)) ?? "";

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const parentPath = headingPath.slice(0, -1);
      const target = headingPath[headingPath.length - 1];
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot rename");
      }

      const oldNode = siblings[idx];
      assertNoDuplicateSiblingHeadingCollision(siblings, {
        operation: "rename",
        docPath,
        parentHeadingPath: parentPath,
        targetSectionFile: oldNode.sectionFile,
        proposedHeading: newHeading,
        proposedLevel: oldNode.level,
      });
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removed = ctx.flattenNode(oldNode, parentPath, parentSkeletonPath);

      // WS-0/WS-2 (rename keeps identity): a relabeled section is the SAME
      // section — REUSE its section-file id so its `section::<id>` live fragment
      // key stays valid (the live heading-edit applier edits the heading node in
      // place; re-keying would force a clobber and lose the body's struct
      // identity / cursors). Only the heading text/level changes.
      const newSectionFile = oldNode.sectionFile;
      const newNode: SkeletonNode = {
        heading: newHeading,
        level: oldNode.level,
        sectionFile: newSectionFile,
        children: oldNode.children,
      };
      siblings.splice(idx, 1, newNode);
      const added = ctx.flattenNode(newNode, parentPath, parentSkeletonPath);

      const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
      const newTopEntry = added.find((e) => !e.isSubSkeleton && e.headingPath.length === parentPath.length + 1);
      if (newTopEntry) {
        bodyWrites.push({ absolutePath: newTopEntry.absolutePath, content: oldBody });
      }

      return {
        removed,
        added,
        bodyWrites,
        // Id reused → no re-key. (from === to would be a no-op remap; omit it.)
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    // Perform the body writes and deletions declared in the plan.
    // NOTE: the renamed section reuses its file id, so `removed` and the new
    // body write target the SAME absolutePath — order matters (rm THEN write).
    for (const entry of plan.removed) {
      await rm(entry.absolutePath, { force: true });
    }
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    return skeleton.requireContentEntryByHeadingPath([...headingPath.slice(0, -1), newHeading]);
  }

  private async retitleSubSkeletonParentInPlace(
    skeleton: DocumentSkeletonInternal,
    docPath: string,
    headingPath: string[],
    newHeading: string,
    newLevel: number,
  ): Promise<{ oldEntry: ContentEntry; newEntry: ContentEntry }> {
    if (headingPath.length === 0) {
      throw new Error(
        `Cannot retitle the before-first-heading section in ${docPath} — it has no heading.`,
      );
    }

    const oldEntry = skeleton.requireContentEntryByHeadingPath(headingPath);
    const parentPath = headingPath.slice(0, -1);
    const target = headingPath[headingPath.length - 1];
    await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot retitle sub-skeleton parent");
      }
      assertNoDuplicateSiblingHeadingCollision(siblings, {
        operation: "rename",
        docPath,
        parentHeadingPath: parentPath,
        targetSectionFile: siblings[idx].sectionFile,
        proposedHeading: newHeading,
        proposedLevel: newLevel,
      });
      siblings[idx].heading = newHeading;
      siblings[idx].level = newLevel;
      return {
        removed: [],
        added: [],
        bodyWrites: [],
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    const newHeadingPath = [...parentPath, newHeading];
    const newEntry = skeleton.requireContentEntryByHeadingPath(newHeadingPath);
    return { oldEntry, newEntry };
  }

  /**
   * Delete ONLY a heading (the one heading line), KEEPING its descendants
   * (WS-2 parent-heading deletion / merge). Semantics (the obvious markdown
   * behavior): the heading node is removed, its OWN direct body merges into the
   * preceding section, and every child subtree RE-PARENTS up into the deleted
   * node's slot — keeping each child's section-file id UNCHANGED so its
   * `section::<id>` live fragment key (and any cursor inside it) survives, even
   * though the child's body file relocates on disk to the new parent directory.
   * This is distinct from `deleteSubtree` (which deletes the children) and from
   * `moveSubtree` (which RE-KEYS the moved nodes — breaking the live identity).
   *
   * The id-preserving re-parent runs inside `applyStructuralMutationTransaction`:
   * locate the target node in its parent's sibling list, splice its non-body-holder
   * children INTO the predecessor (keeping the child node objects → ids preserved),
   * merge the target's body-holder body into the predecessor section, and drop the
   * now-childless target node. Returns the engine's `{ removed, added }` flat
   * entries (relocated children appear as removed-at-old-path + added-at-new-path
   * with the SAME sectionFile) so a caller (e.g. the quiescence merge reflection)
   * can remap its section-claim manifest from the OLD to the NEW descendant paths
   * without re-deriving the whole proposal.
   */
  async removeHeadingPreservingChildren(
    docPath: string,
    headingPath: string[],
  ): Promise<{ removed: FlatEntry[]; added: FlatEntry[] }> {
    if (headingPath.length === 0) {
      throw new Error(`Cannot delete the before-first-heading section's heading in ${docPath}.`);
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    const targetNode = skeleton.findStructuralNodeByHeadingPath(headingPath);
    if (!targetNode) throw staleHeadingPath(docPath, headingPath, "cannot delete heading");

    const parentPath = headingPath.slice(0, -1);
    const targetHeading = headingPath[headingPath.length - 1];

    // Resolve the doc-order predecessor among same-parent siblings (the section
    // the deleted heading's body folds into, and the new parent for its children).
    const siblingPaths = (await this.getSectionList(docPath))
      .filter(
        (s) =>
          s.headingPath.length === parentPath.length + 1 &&
          parentPath.every((seg, i) => headingsEqual(seg, s.headingPath[i])),
      )
      .map((s) => s.headingPath);
    const targetSiblingIdx = siblingPaths.findIndex((p) => headingsEqual(p[p.length - 1], targetHeading));
    if (targetSiblingIdx <= 0) {
      // No preceding sibling to absorb the body / re-parent under. (Deleting the
      // first section's heading is the BFH-merge case handled elsewhere.)
      throw new Error(
        `removeHeadingPreservingChildren: "${headingPath.join(" > ")}" has no preceding sibling in ${docPath}.`,
      );
    }
    const predecessorPath = siblingPaths[targetSiblingIdx - 1];

    // Read all descendant bodies (keyed by section-file id) + the predecessor body
    // BEFORE mutating — the re-parent preserves ids, so we re-write each child's
    // body at its NEW path under the same id.
    const bodyById = new Map<string, string>();
    let targetOwnBody = "" as SectionBody;
    for (const entry of skeleton.subtreeEntries(headingPath)) {
      const body = bodyFromDisk((await this.readEffectiveSectionBody(entry.absolutePath)) ?? "");
      bodyById.set(entry.sectionFile, body);
      if (headingPathKey(entry.headingPath) === headingPathKey(headingPath)) {
        // The target's OWN direct body (its body-holder, or itself if a leaf).
        targetOwnBody = body;
      }
    }
    const predecessorEntry = skeleton.findContentEntryByHeadingPath(predecessorPath);
    const predecessorOldBody = predecessorEntry
      ? bodyFromDisk((await this.readEffectiveSectionBody(predecessorEntry.absolutePath)) ?? "")
      : ("" as SectionBody);
    const predecessorOldAbsolutePath = predecessorEntry?.absolutePath ?? null;
    const mergedPredecessorBody = appendToBody(predecessorOldBody, targetOwnBody);

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, targetHeading));
      if (idx <= 0) throw staleHeadingPath(docPath, headingPath, "cannot delete heading");
      const target = siblings[idx];
      const predecessor = siblings[idx - 1];
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);

      // Capture the target's ORIGINAL subtree for cleanup (old child file paths +
      // the target's own sub-skeleton/body-holder) before we move anything.
      const removed = ctx.flattenNode(target, parentPath, parentSkeletonPath);
      // Also retire the predecessor's OLD leaf body file when it becomes a parent
      // (its id is reused for a body-holder at a NEW path; the old leaf is stale).
      const extraRemoved: FlatEntry[] = [];

      const realChildren = target.children.filter((c) => !isBodyHolderShape(c));

      if (realChildren.length > 0) {
        // The predecessor gains children → it must become a sub-skeleton parent.
        const predHasBodyHolder = predecessor.children.some((c) => isBodyHolderShape(c));
        if (predecessor.children.length === 0) {
          // Leaf → parent: reuse the predecessor's id as its body-holder (so its
          // live fragment key survives) and mint a fresh sub-skeleton id.
          const predOldId = predecessor.sectionFile;
          if (predecessorOldAbsolutePath) {
            extraRemoved.push({
              headingPath: [...predecessorPath],
              heading: predecessor.heading,
              level: predecessor.level,
              sectionFile: predOldId,
              absolutePath: predecessorOldAbsolutePath,
              isSubSkeleton: false,
            });
          }
          predecessor.sectionFile = generateSectionFilename(predecessor.heading);
          predecessor.children.push({ heading: "", level: 0, sectionFile: predOldId, children: [] });
        } else if (!predHasBodyHolder) {
          // Already a parent but no body-holder — give it one (fresh id is fine;
          // its body lived inline previously only if it was a leaf, handled above).
          ctx.addBodyHoldersToParents([predecessor]);
        }
        // Re-parent the moved children (the node OBJECTS — ids preserved).
        predecessor.children.push(...realChildren);
      }

      // Remove the target node.
      siblings.splice(idx, 1);

      // The predecessor's NEW subtree gives the moved children their new paths.
      const added = ctx.flattenNode(predecessor, parentPath, parentSkeletonPath);

      // Body writes: predecessor body-holder ← merged body; each moved child (by
      // id) ← its preserved body at the new path.
      const predContent = added.find(
        (e) => !e.isSubSkeleton && headingPathKey(e.headingPath) === headingPathKey(predecessorPath),
      );
      const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
      if (predContent) bodyWrites.push({ absolutePath: predContent.absolutePath, content: mergedPredecessorBody as string });
      for (const entry of added) {
        if (entry.isSubSkeleton) continue;
        if (predContent && entry.absolutePath === predContent.absolutePath) continue;
        const preserved = bodyById.get(entry.sectionFile);
        if (preserved !== undefined) bodyWrites.push({ absolutePath: entry.absolutePath, content: preserved });
      }

      return {
        removed: [...removed, ...extraRemoved],
        added,
        bodyWrites,
        // Children keep their ids (no re-key); the target's own body merged into
        // the predecessor (its body-holder/leaf file is removed, not remapped).
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    for (const entry of plan.removed) {
      if (entry.isSubSkeleton) await rm(`${entry.absolutePath}.sections`, { recursive: true, force: true });
      await rm(entry.absolutePath, { force: true });
    }
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    return { removed: plan.removed, added: plan.added };
  }

  /**
   * Id-preserving in-place retitle/re-level of a section (WS-2 rename /
   * level-change reflection). Sets the heading text AND level on the existing
   * skeleton node WITHOUT minting a new section-file id (so the section's
   * `section::<id>` live fragment key stays valid and the live heading-edit
   * applier's identity preservation holds end-to-end), then writes `body` into
   * the section's content entry (leaf or body-holder). Works for both leaf and
   * sub-skeleton-parent targets. Returns the resulting content entry.
   */
  async retitleSectionInPlace(
    docPath: string,
    headingPath: string[],
    newHeading: string,
    newLevel: number,
    body: SectionBody,
  ): Promise<ContentEntry> {
    if (headingPath.length === 0) {
      throw new Error(`Cannot retitle the before-first-heading section in ${docPath} — it has no heading.`);
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    skeleton.requireContentEntryByHeadingPath(headingPath); // assert exists
    const parentPath = headingPath.slice(0, -1);
    const target = headingPath[headingPath.length - 1];
    await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) throw staleHeadingPath(docPath, headingPath, "cannot retitle");
      assertNoDuplicateSiblingHeadingCollision(siblings, {
        operation: "rename",
        docPath,
        parentHeadingPath: parentPath,
        targetSectionFile: siblings[idx].sectionFile,
        proposedHeading: newHeading,
        proposedLevel: newLevel,
      });
      siblings[idx].heading = newHeading;
      siblings[idx].level = newLevel;
      return { removed: [], added: [], bodyWrites: [], fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
    });
    const newHeadingPath = [...parentPath, newHeading];
    const newEntry = skeleton.requireContentEntryByHeadingPath(newHeadingPath);
    await this.writeOverlayBodyFile(
      docPath,
      { absolutePath: newEntry.absolutePath, isSubSkeleton: false } as FlatEntry,
      body as string,
    );
    return newEntry;
  }

  /**
   * Move a subtree under a new parent at a specified level. Composes an
   * explicit delete-at-source + insert-at-destination inside a single
   * transaction — callers never observe the intermediate half-mutated
   * state. Body content for every descendant is preserved.
   */
  async moveSubtree(
    docPath: string,
    headingPath: string[],
    newParentPath: string[],
    newLevel: number,
  ): Promise<{ removed: FlatEntry[]; added: FlatEntry[] }> {
    if (headingPath.length === 0) {
      throw new Error(
        `Cannot move the before-first-heading section in ${docPath}.`,
      );
    }
    const skeleton = await this.getWritableSkeleton(docPath);

    // Read the entire subtree's body content BEFORE mutating.
    //
    // Per item 209: must use overlay+canonical-aware fallback. The previous
    // raw `readFile(entry.absolutePath, ...)` against the overlay path
    // dropped body content for canonical-only sections (the overlay file
    // does not exist yet for any section that hasn't been edited in this
    // proposal), causing the move to silently empty those descendants.
    const preEntries = skeleton.subtreeEntries(headingPath);
    const preBodies = new Map<string, string>();
    for (const entry of preEntries) {
      if (entry.isSubSkeleton) continue;
      const relKey = entry.headingPath.slice(headingPath.length - 1).join("\u0000");
      preBodies.set(relKey, (await this.readEffectiveSectionBody(entry.absolutePath)) ?? "");
    }

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const parentPath = headingPath.slice(0, -1);
      const target = headingPath[headingPath.length - 1];
      const sourceSiblings = ctx.findSiblingList(parentPath);
      const sourceIdx = sourceSiblings.findIndex((n) => headingsEqual(n.heading, target));
      if (sourceIdx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot move (source)");
      }
      const movedNode = sourceSiblings[sourceIdx];

      // Reject a move that would place the section next to a same-parent
      // sibling with the same heading text at the destination level. Runs
      // BEFORE any splice so the in-memory skeleton is untouched on rejection.
      // Excluding the moved node's own `sectionFile` allows a no-op /
      // same-location move (source and destination parents equal) to succeed.
      const destSiblingsCheck = ctx.findSiblingList(newParentPath);
      assertNoDuplicateSiblingHeadingCollision(destSiblingsCheck, {
        operation: "move",
        docPath,
        parentHeadingPath: newParentPath,
        targetSectionFile: movedNode.sectionFile,
        proposedHeading: movedNode.heading,
        proposedLevel: newLevel,
      });

      const removed = ctx.flattenNode(movedNode, parentPath, ctx.resolveSkeletonPathFor(parentPath));
      sourceSiblings.splice(sourceIdx, 1);

      // Retarget the moved node to the new level, PRESERVING its section-file id
      // (identity-based delete detection, D4): paths move, ids do not. Keeping the
      // id means the manifest-overlay merge still matches the moved section — and
      // its (possibly deleted) descendants — to canonical BY ID. Re-keying here
      // would make the merge treat the canonical original as an unmatched inherited
      // section and splice it back in wholesale, resurrecting any deleted
      // descendant and duplicating the moved section. (A pure sibling reorder
      // already preserves the id; a reparent now does too — and live fragment keys
      // survive a move, so no remap is emitted.)
      const relabeled: SkeletonNode = {
        heading: movedNode.heading,
        level: newLevel,
        sectionFile: movedNode.sectionFile,
        children: movedNode.children,
      };

      const destSiblings = ctx.findSiblingList(newParentPath);
      destSiblings.push(relabeled);

      // Destination parent may have just become a sub-skeleton parent.
      const destSkeletonPath = ctx.resolveSkeletonPathFor(newParentPath);
      if (newParentPath.length > 0) {
        const grandparentPath = newParentPath.slice(0, -1);
        const parentSiblings = ctx.findSiblingList(grandparentPath);
        const parentNode = parentSiblings.find((n) =>
          headingsEqual(n.heading, newParentPath[newParentPath.length - 1]),
        );
        if (parentNode) ctx.addBodyHoldersToParents([parentNode]);
      }
      const added = ctx.flattenNode(relabeled, newParentPath, destSkeletonPath);

      // Derive body writes from preBodies map using the post-move heading paths.
      const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
      for (const addedEntry of added) {
        if (addedEntry.isSubSkeleton) continue;
        const rel = addedEntry.headingPath.slice(newParentPath.length).join("\u0000");
        const body = preBodies.get(rel);
        if (body !== undefined) {
          bodyWrites.push({ absolutePath: addedEntry.absolutePath, content: body });
        }
      }

      return {
        removed,
        added,
        bodyWrites,
        // Id preserved across the move → no fragment-key remap (live keys survive).
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    for (const entry of plan.removed) {
      if (entry.isSubSkeleton) {
        await rm(`${entry.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(entry.absolutePath, { force: true });
    }
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    return { removed: plan.removed, added: plan.added };
  }

  /**
   * Reposition `headingPath` relative to a same-parent sibling `targetHeading`
   * (the leaf heading of `targetHeadingPath`), placing it immediately before or
   * after that sibling. This is the cross-section drag/drop reorder primitive
   * (MW-10): a pure positional splice within one parent's sibling list — the
   * section keeps its level, sectionFile id, body, and descendants, so there is
   * NO fragment-key remap and NO body rewrite (data is preserved exactly).
   *
   * Reparenting (a move to a DIFFERENT parent or level) is `moveSubtree`'s job;
   * this method only reorders siblings and throws when source and target do not
   * share a parent. The skeleton is persisted via the structural-mutation
   * transaction (which flushes the reordered skeleton to the overlay).
   */
  async reorderSiblingSection(
    docPath: string,
    headingPath: string[],
    targetHeadingPath: string[],
    position: "before" | "after",
  ): Promise<void> {
    if (headingPath.length === 0) {
      throw new Error(`Cannot reorder the before-first-heading section in ${docPath}.`);
    }
    if (targetHeadingPath.length === 0) {
      throw new Error(`Cannot reorder relative to the before-first-heading section in ${docPath}.`);
    }
    const parentPath = headingPath.slice(0, -1);
    const targetParentPath = targetHeadingPath.slice(0, -1);
    if (parentPath.length !== targetParentPath.length || !parentPath.every((p, i) => p === targetParentPath[i])) {
      throw new Error(
        `reorderSiblingSection in ${docPath}: source [${headingPath.join(" > ")}] and target ` +
        `[${targetHeadingPath.join(" > ")}] are not siblings (different parent). ` +
        `Use moveSubtree for reparenting.`,
      );
    }

    const skeleton = await this.getWritableSkeleton(docPath);
    await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      const sourceLeaf = headingPath[headingPath.length - 1];
      const targetLeaf = targetHeadingPath[targetHeadingPath.length - 1];
      const sourceIdx = siblings.findIndex((n) => headingsEqual(n.heading, sourceLeaf));
      if (sourceIdx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot reorder (source)");
      }
      const targetIdx = siblings.findIndex((n) => headingsEqual(n.heading, targetLeaf));
      if (targetIdx < 0) {
        throw staleHeadingPath(docPath, targetHeadingPath, "cannot reorder (target)");
      }
      if (sourceIdx === targetIdx) {
        // No-op reorder relative to self.
        return { removed: [], added: [], bodyWrites: [], fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
      }

      const [movedNode] = siblings.splice(sourceIdx, 1);
      // Recompute the target index after removal — the splice may have shifted it.
      const newTargetIdx = siblings.findIndex((n) => headingsEqual(n.heading, targetLeaf));
      const insertAt = position === "before" ? newTargetIdx : newTargetIdx + 1;
      siblings.splice(insertAt, 0, movedNode);

      // Pure positional reorder: nothing removed/added/rewritten, no key remap.
      return { removed: [], added: [], bodyWrites: [], fragmentKeyRemaps: [] } satisfies StructuralMutationPlan;
    });
  }

  /**
   * Rewrite the subtree at `headingPath` from a pre-parsed markdown section
   * list, preserving the targeted slot in its parent.
   *
   * The parsed section list is interpreted structurally via its parsed
   * `headingPath` relationships, not by ad hoc level bucketing.
   *
   * `headingPath=[]` is ILLEGAL here. `[]` is never a subtree-rewrite target:
   * a before-first-heading write is body-only
   * (`writeSectionBodyVerbatim(...)`), and a whole-document structural
   * rewrite is a document-level operation
   * (`replaceWholeDocumentFromParsedMarkdown(...)` /
   * `writeFreshDocumentFromParsedMarkdown(...)`, reached via
   * `upsertDocumentFromMarkdown(...)`). Passing `[]` here would parse BFH body
   * text into root replacement nodes and silently rewrite the whole document.
   * A real top-level section (`headingPath.length === 1`, hence
   * `parentPath === []`) is the shallowest legal target.
   *
   * Item 369 — `options.leadingOrphanBody`:
   * When the user-supplied markdown contained content BEFORE the target
   * heading (a leading "level-0 orphan" emitted by the parser), the caller
   * passes that body here. The orphan absorbs into whichever section came
   * directly before the target in document order. If there is no preceding
   * body-holder, a fresh BFH is auto-created at the front of the document
   * to receive the orphan body. The merge is performed atomically inside
   * the same `applyStructuralMutationTransaction(...)` that mutates the
   * skeleton — the orphan-append bodyWrite is emitted into the plan's
   * `bodyWrites` array, NOT applied as a separate post-transaction I/O
   * step, so partial-state cannot leak to disk if the structural mutation
   * throws mid-transaction.
   *
   * Empty `leadingOrphanBody` short-circuits — no merge target is
   * resolved, no extra body read happens, no extra bodyWrite is emitted.
   */
  private async rewriteSubtreeFromParsedMarkdown(
    docPath: string,
    headingPath: string[],
    parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
    options?: { leadingOrphanBody?: SectionBody },
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    if (headingPath.length === 0) {
      throw new Error(
        `rewriteSubtreeFromParsedMarkdown called with headingPath=[] in ${docPath}. ` +
        `'[]' is not a subtree target — a before-first-heading write is body-only ` +
        `(writeSectionBodyVerbatim(...)) and a whole-document rewrite is a ` +
        `document-level operation (upsertDocumentFromMarkdown(...)).`,
      );
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    const targetNode = skeleton.findStructuralNodeByHeadingPath(headingPath);
    if (!targetNode) {
      throw staleHeadingPath(docPath, headingPath, "cannot rewrite");
    }
    const targetContentEntry = skeleton.findContentEntryByHeadingPath(headingPath);
    if (!targetContentEntry) {
      throw staleHeadingPath(docPath, headingPath, "cannot rewrite content");
    }

    const parentPath = headingPath.slice(0, -1);
    // WS-0: gather the existing body-bearing entries of the subtree being
    // rewritten so split/merge survivors reuse their existing section-file id
    // (preserving their `section::<id>` live fragment key) instead of minting a
    // fresh one. `subtreeEntries` returns content entries (body-holders + leaves,
    // sub-skeleton parents filtered out) with absolute heading paths — exactly
    // the resulting-path keys `buildRewriteReplacementRoots` matches against.
    // `headingPath` is guaranteed non-empty by the guard above, so
    // `subtreeEntries(headingPath)` (illegal on `[]`) is always safe here.
    const existingContentByResultingPath = new Map<string, string>();
    for (const existing of skeleton.subtreeEntries(headingPath)) {
      existingContentByResultingPath.set(headingPathKey(existing.headingPath), existing.sectionFile);
    }
    const { replacementRoots, bodyByResultingHeadingPath } = buildRewriteReplacementRoots(
      parentPath,
      parsedSections,
      existingContentByResultingPath,
    );

    // ── Item 369: leadingOrphanBody pre-mutation snapshot ─────────────
    //
    // If the caller passed a non-empty leading orphan, snapshot the
    // current previous-body-holder BEFORE the structural mutation, and
    // read its existing content via overlay+canonical fallback. The
    // snapshot survives any structural mutation we perform inside the
    // transaction below because the previous body-holder is upstream of
    // the target slot — we never touch it during a rewrite.
    //
    // Empty (or undefined) leadingOrphanBody short-circuits: no snapshot,
    // no body read, no extra bodyWrite emitted. The existing rewrite
    // path applies unchanged.
    const leadingOrphanBody = (options?.leadingOrphanBody ?? "") as SectionBody;
    const hasOrphan = (leadingOrphanBody as string).length > 0;

    let preMutationMergeTarget: FlatEntry | null = null;
    let existingMergeBody: SectionBody = "" as SectionBody;
    if (hasOrphan) {
      preMutationMergeTarget = skeleton.findPreviousBodyHolder(targetNode.sectionFile);
      if (preMutationMergeTarget) {
        existingMergeBody = bodyFromDisk(
          (await this.readEffectiveSectionBody(preMutationMergeTarget.absolutePath)) ?? "",
        );
      }
    }

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => n.sectionFile === targetNode.sectionFile);
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot rewrite");
      }
      const oldNode = siblings[idx];
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removed = ctx.flattenNode(oldNode, parentPath, parentSkeletonPath);
      ctx.addBodyHoldersToParents(replacementRoots);
      siblings.splice(idx, 1, ...replacementRoots);

      const added: FlatEntry[] = [];
      for (const node of replacementRoots) {
        added.push(...ctx.flattenNode(node, parentPath, parentSkeletonPath));
      }

      const bodyWrites = buildBodyWritesForRewrite(docPath, added, bodyByResultingHeadingPath);

      // ── Item 369: orphan-append bodyWrite emission ────────────────
      //
      // If we have a leading orphan to absorb, decide where it goes:
      //   (a) preMutationMergeTarget snapshot is non-null → append to
      //       that section's existing body and emit the bodyWrite.
      //   (b) snapshot is null → no preceding body-holder existed; mint
      //       a fresh BFH at the front of roots via the context helper
      //       and emit the bodyWrite directly into it.
      //
      // Both branches emit the bodyWrite into the SAME `bodyWrites`
      // array as the rewrite path itself. This guarantees atomicity:
      // a structural-mutation throw aborts BOTH the rewrite AND the
      // orphan absorption together, with nothing escaping to disk.
      if (hasOrphan) {
        if (preMutationMergeTarget) {
          bodyWrites.push({
            absolutePath: preMutationMergeTarget.absolutePath,
            content: appendToBody(existingMergeBody, leadingOrphanBody),
          });
        } else {
          const bfhEntry = ctx.createBfhAtFront();
          added.push(bfhEntry);
          bodyWrites.push({
            absolutePath: bfhEntry.absolutePath,
            content: leadingOrphanBody,
          });
        }
      }

      // WS-0: emit a fragment-key remap ONLY when the target's section-file id
      // did NOT survive the rewrite. With survivor id-reuse the old id is
      // preserved (on the surviving leaf, or carried onto a pre-seeded
      // body-holder when the leaf became a parent), so there is no re-key and no
      // remap — the live fragment keeps its identity. Only when the old id truly
      // disappears (e.g. the heading was renamed, or the whole subtree replaced)
      // do we remap it onto the first resulting content entry.
      const survivingFiles = new Set(added.filter((e) => !e.isSubSkeleton).map((e) => e.sectionFile));
      const oldIdSurvived = survivingFiles.has(oldNode.sectionFile);
      const firstContentFile = added.find((e) => !e.isSubSkeleton)?.sectionFile ?? null;
      const fragmentKeyRemaps = oldIdSurvived
        ? []
        : [{ from: oldNode.sectionFile, to: firstContentFile }];

      return {
        removed,
        added,
        bodyWrites,
        fragmentKeyRemaps,
      } satisfies StructuralMutationPlan;
    });

    for (const entry of plan.removed) {
      if (entry.isSubSkeleton) {
        await rm(`${entry.absolutePath}.sections`, { recursive: true, force: true });
      }
      await rm(entry.absolutePath, { force: true });
    }
    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    // Item 369 follow-up: when the leading orphan was absorbed into an
    // EXISTING previous body holder (not a freshly-minted BFH that lives
    // in plan.added), the merge target is structurally upstream of the
    // rewritten slot and never appears in plan.added. The CRDT fragment
    // for that section is therefore stale against the orphan-appended
    // body unless we explicitly include the merge target in
    // liveReloadEntries / writtenEntries so the caller's
    // reconcileLiveFragmentsFromDetailedResult re-reads it from disk.
    const addedNonSub = plan.added.filter((e) => !e.isSubSkeleton);
    const writtenEntries = [...addedNonSub];
    const liveReloadEntries = [...addedNonSub];
    if (preMutationMergeTarget) {
      writtenEntries.push(preMutationMergeTarget);
      liveReloadEntries.push(preMutationMergeTarget);
    }
    return {
      writtenEntries,
      removedContentEntries: plan.removed.filter((e) => !e.isSubSkeleton),
      fragmentKeyRemaps: plan.fragmentKeyRemaps,
      liveReloadEntries,
      structureChanges: [{
        oldEntry: flatEntryFromContentEntry(targetContentEntry),
        newEntries: addedNonSub,
      }],
    };
  }

  /**
   * Write parsed markdown into an empty (roots.length === 0, no .sections/ dir)
   * overlay skeleton. This is the dedicated whole-document creation path — it
   * does NOT handle non-empty starting state (use rewriteSubtreeFromParsedMarkdown
   * for that).
   */
  private async writeFreshDocumentFromParsedMarkdown(
    docPath: string,
    parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
  ): Promise<void> {
    const skeleton = await this.getWritableSkeleton(docPath);
    if (!skeleton.areSkeletonRootsEmpty) {
      throw new Error(
        `writeFreshDocumentFromParsedMarkdown(${docPath}): precondition violated — ` +
        `skeleton is not empty. ` +
        `This method only handles live-empty documents.`,
      );
    }
    const overlaySkeletonPath = resolveSkeletonPath(docPath, this.overlayRoot);
    const sectionsDirPath = `${overlaySkeletonPath}.sections`;
    let sectionsDirExists = false;
    try {
      await stat(sectionsDirPath);
      sectionsDirExists = true;
    } catch {
      // ENOENT — expected when live-empty
    }
    if (sectionsDirExists) {
      throw new Error(
        `writeFreshDocumentFromParsedMarkdown(${docPath}): precondition violated — ` +
        `overlay .sections/ directory already exists at ${sectionsDirPath}. ` +
        `This method only handles live-empty documents.`,
      );
    }

    const { replacementRoots, bodyByResultingHeadingPath } = buildRewriteReplacementRoots(
      [],
      parsedSections,
    );

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      ctx.addBodyHoldersToParents(replacementRoots);
      const roots = ctx.findSiblingList([]);
      roots.splice(0, 0, ...replacementRoots);

      const added: FlatEntry[] = [];
      const parentSkeletonPath = ctx.resolveSkeletonPathFor([]);
      for (const node of replacementRoots) {
        added.push(...ctx.flattenNode(node, [], parentSkeletonPath));
      }

      const bodyWrites = buildBodyWritesForRewrite(docPath, added, bodyByResultingHeadingPath);

      return {
        removed: [],
        added,
        bodyWrites,
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
  }

  /**
   * Materialize ancestor headings (item 63). Ensures that every prefix of
   * headingPath exists in the skeleton, creating empty headings with
   * parent.level + 1 as needed. Before-first-heading auto-creation for
   * headingPath=[] is covered here too.
   *
   * This is the explicit named operation that callers previously emulated
   * by looping has()/expect()/insertSectionUnder(...) inline.
   */
  private async materializeAncestorHeadings(docPath: string, headingPath: string[]): Promise<FlatEntry[]> {
    const skeleton = await this.getWritableSkeleton(docPath);
    const created: FlatEntry[] = [];

    // Bug E1: when an existing leaf ancestor is about to gain its first child
    // we must migrate the leaf's body content into a freshly-prepended body
    // holder under that ancestor — otherwise writeTree overwrites the leaf
    // file with sub-skeleton markers and silently destroys the body. Walk
    // headingPath strictly above the new node (i < headingPath.length, not <=)
    // to find the deepest existing leaf ancestor that will become a sub-
    // skeleton parent during this transaction. Capture its body BEFORE the
    // transaction so the snapshot is uncontaminated.
    let leafParentPath: string[] | null = null;
    let leafParentBody: SectionBody | null = null;
    let bhAbsolutePathForMigration: string | null = null;
    for (let i = 1; i < headingPath.length; i++) {
      const ancestorPath = headingPath.slice(0, i);
      if (!skeleton.has(ancestorPath)) break;
      const isLeaf = skeleton.subtreeEntries(ancestorPath).length === 1;
      if (isLeaf) {
        leafParentPath = ancestorPath;
      }
    }
    if (leafParentPath !== null) {
      const entry = skeleton.requireContentEntryByHeadingPath(leafParentPath);
      leafParentBody = bodyFromDisk((await this.readEffectiveSectionBody(entry.absolutePath)) ?? "");
    }

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const newlyAdded: FlatEntry[] = [];

      // BFH materialization for headingPath=[]
      if (headingPath.length === 0 && !skeleton.has([])) {
        const bfhFile = generateBeforeFirstHeadingFilename();
        const bfhNode: SkeletonNode = { heading: "", level: 0, sectionFile: bfhFile, children: [] };
        ctx.roots.unshift(bfhNode);
        newlyAdded.push(...ctx.flattenNode(bfhNode, [], resolveSkeletonPath(docPath, this.overlayRoot)));
      }

      // ── Build the WHOLE missing ancestor chain in-memory first ────────────
      //
      // Each newly-created intermediate segment is pushed into its (already
      // existing or just-created) parent's children. We deliberately DO NOT
      // flatten nodes one-at-a-time here: a node flattened at creation time
      // still has `children: []`, so it would be recorded as a leaf
      // (`isSubSkeleton: false`) and later emit an empty body write that
      // overwrites the sub-skeleton file `writeTree` produces for it — the
      // root cause of the multi-new-segment skeleton-integrity failure.
      // Instead we build the entire chain, materialize body holders for every
      // new parent, and flatten ONCE at the end (mirroring appendRootSections).
      //
      // `topNewParentPath` is the shallowest path whose node was created in
      // this transaction (or the shallowest pre-existing leaf-turned-parent).
      // Flattening from there captures the full nested subtree with correct
      // `isSubSkeleton` flags. `newNodePaths` records which content sections
      // are genuinely new so we only emit empty body writes for those.
      let topNewParentPath: string[] | null = null;
      const newSegmentPaths: string[][] = [];
      for (let i = 1; i <= headingPath.length; i++) {
        const ancestorPath = headingPath.slice(0, i);
        if (skeleton.has(ancestorPath)) continue;
        if (topNewParentPath === null) topNewParentPath = ancestorPath;
        const parentPath = ancestorPath.slice(0, -1);
        const parentSiblings = ctx.findSiblingList(parentPath);
        const level = parentPath.length === 0
          ? 1
          : skeleton.requireStructuralNodeByHeadingPath(parentPath).level + 1;
        const heading = ancestorPath[ancestorPath.length - 1];
        const node: SkeletonNode = {
          heading,
          level,
          sectionFile: generateSectionFilename(heading),
          children: [],
        };
        parentSiblings.push(node);
        newSegmentPaths.push([...ancestorPath]);
      }

      // Body-holder materialization for the captured pre-existing leaf parent.
      // A leaf that gains its first child must migrate its body into a freshly
      // prepended body holder, else writeTree clobbers the body file with
      // sub-skeleton markers. Capture that body holder so its body write
      // carries the pre-migration content rather than empty string. This must
      // happen before the general addBodyHoldersToParents pass below; that pass
      // is idempotent (it skips parents that already have a body holder), so
      // the leaf parent's body holder is added exactly once.
      let migratedBhHeadingPath: string[] | null = null;
      if (leafParentPath !== null && leafParentBody !== null) {
        const grandparentPath = leafParentPath.slice(0, -1);
        const grandparentSiblings = ctx.findSiblingList(grandparentPath);
        const lastSegment = leafParentPath[leafParentPath.length - 1];
        const parentNode = grandparentSiblings.find((n) => headingsEqual(n.heading, lastSegment));
        if (!parentNode) {
          throw new Error(
            `Skeleton integrity error in ${docPath}: leaf parent ` +
            `[${leafParentPath.join(" > ")}] vanished during materializeAncestorHeadings`,
          );
        }
        ctx.addBodyHoldersToParents([parentNode]);
        const bh = parentNode.children[0];
        if (!bh || bh.level !== 0 || bh.heading !== "") {
          throw new Error(
            `Skeleton integrity error in ${docPath}: addBodyHoldersToParents ` +
            `did not prepend body holder for [${leafParentPath.join(" > ")}]`,
          );
        }
        const parentSkeletonPath = ctx.resolveSkeletonPathFor(leafParentPath);
        bhAbsolutePathForMigration = path.join(`${parentSkeletonPath}.sections`, bh.sectionFile);
        migratedBhHeadingPath = [...leafParentPath];
        // The leaf parent is an ancestor of (or shallower than) any new
        // segment, and it now owns a freshly prepended body holder that must
        // be flattened. Anchor the single flatten at the leaf parent whenever
        // it is shallower than the shallowest new segment so the migrated body
        // holder is included.
        if (topNewParentPath === null || leafParentPath.length < topNewParentPath.length) {
          topNewParentPath = [...leafParentPath];
        }
      }

      // Materialize body holders for every brand-new intermediate parent in
      // the freshly built chain. Without this, an intermediate segment (e.g.
      // "Getting Started" / "Installation" in [GS, Inst, Linux]) becomes a
      // sub-skeleton parent with NO content-addressable body file and the
      // skeleton fails to resolve descendants on reload. addBodyHoldersToParents
      // is idempotent, so the already-handled leaf parent above is untouched.
      for (const segPath of newSegmentPaths) {
        const node = ctx.findSiblingList(segPath.slice(0, -1))
          .find((n) => headingsEqual(n.heading, segPath[segPath.length - 1]));
        if (node) ctx.addBodyHoldersToParents([node]);
      }

      // Flatten the complete subtree ONCE so isSubSkeleton flags and the
      // materialized body-holder entries are all captured correctly.
      if (topNewParentPath !== null) {
        const topParentPath = topNewParentPath.slice(0, -1);
        const topNode = ctx.findSiblingList(topParentPath)
          .find((n) => headingsEqual(n.heading, topNewParentPath![topNewParentPath!.length - 1]));
        if (!topNode) {
          throw new Error(
            `Skeleton integrity error in ${docPath}: top new ancestor ` +
            `[${topNewParentPath.join(" > ")}] vanished during materializeAncestorHeadings`,
          );
        }
        newlyAdded.push(
          ...ctx.flattenNode(topNode, topParentPath, ctx.resolveSkeletonPathFor(topParentPath)),
        );
      }

      // Body writes: only for genuine body-file entries (leaf sections and
      // body holders), never for sub-skeleton parents (writeTree owns their
      // skeleton files). The migrated leaf-parent body holder carries the
      // captured pre-migration body; everything else starts empty.
      const migratedBhKey = migratedBhHeadingPath !== null
        ? migratedBhHeadingPath.join(" ")
        : null;
      const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
      const seenBodyPaths = new Set<string>();
      for (const e of newlyAdded) {
        if (e.isSubSkeleton) continue;
        if (seenBodyPaths.has(e.absolutePath)) continue;
        seenBodyPaths.add(e.absolutePath);
        const isMigratedBh =
          migratedBhKey !== null
          && e.level === 0
          && e.heading === ""
          && e.headingPath.join(" ") === migratedBhKey;
        bodyWrites.push({
          absolutePath: e.absolutePath,
          content: isMigratedBh ? (leafParentBody as unknown as string) : "",
        });
      }

      return {
        removed: [],
        added: newlyAdded,
        bodyWrites,
        fragmentKeyRemaps: [],
      } satisfies StructuralMutationPlan;
    });

    for (const write of plan.bodyWrites) {
      await this.writeOverlayBodyFile(
        docPath,
        { absolutePath: write.absolutePath, isSubSkeleton: false } as FlatEntry,
        write.content,
      );
    }
    created.push(...plan.added);
    return created;
  }

  /**
   * Tombstone-the-document replacement for the deleted
   * DocumentSkeleton.createTombstone static. Lives on ContentLayer
   * because per item 133 tombstone creation must not be reachable from
   * the readonly DocumentSkeleton class, and per the user's override
   * "great yes move it to ContentLayer".
   *
   * Writes a tombstone marker file and removes the overlay skeleton +
   * its sections directory. Per item 191 there is no class-level
   * skeleton cache to invalidate.
   */
  async tombstoneDocumentExplicit(docPath: string): Promise<void> {
    // Proposal deletion MEANING: remove the proposal skeleton + its sections tree,
    // then drop the single-root tombstone marker via the DS storage primitive.
    const overlaySkeletonPath = resolveSkeletonPath(docPath, this.overlayRoot);
    await rm(overlaySkeletonPath, { force: true });
    await rm(`${overlaySkeletonPath}.sections`, { recursive: true, force: true });
    await writeTombstoneMarker(docPath, this.overlayRoot);
  }
}
