/**
 * ContentLayer — Uniform interface for reading/writing section content
 * from a content root directory.
 *
 * Constructed from a single contentRoot path and used for canonical-only
 * reads/writes. Overlay+canonical behavior lives in OverlayContentLayer.
 */

import { readFile, writeFile, mkdir, copyFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  DocumentSkeleton,
  DocumentSkeletonInternal,
  readOverlayDocumentState,
  resolveSkeletonPath,
  resolveTombstonePath,
  skeletonFileExists,
  generateSectionFilename,
  generateBeforeFirstHeadingFilename,
  headingsEqual,
  type FlatEntry,
  type OverlayDocumentState,
  type SkeletonNode,
  type StructuralMutationPlan,
} from "./document-skeleton.js";
import { normalizeDocPath } from "./path-utils.js";
import { staleHeadingPath } from "./skeleton-errors.js";
// ParsedDocument was previously imported here for the document-replacement
// engine in the old `replaceDocumentFromMarkdown(...)`. Item 355 reduced that
// method to a thin wrapper over the section upsert core, so this
// module no longer needs the import. The parser is invoked deeper in the
// upsert path via `getParser()` (markdown-parser.js) and through the
// `OverlayContentLayer.rewriteSubtreeFromParsedMarkdown(...)` machinery.
import type { DocStructureNode } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { bodyFromDisk, bodyFromParser, stripHeadingFromFragment, buildFragmentContent, assembleFragments, bodyAsFragment, stripLeadingNewlines, appendToBody, fragmentFromExternalContent, type SectionBody, type FragmentContent } from "./section-formatting.js";
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
 * The CRDT flush path (DocumentFragments.extractMarkdown) inherently normalizes
 * as a side-effect of Y.Doc→markdown serialization via jsonToMarkdown, so
 * content from that path is already normalized — the second pass here is a
 * no-op because the round-trip is idempotent. This double-application is
 * unavoidable because extractMarkdown cannot produce markdown without
 * jsonToMarkdown (it's the serialization step, not an optional normalization),
 * and we cannot skip normalization here because all other write paths do not
 * normalize. The arbitrary-markdown upsert paths (`OverlayContentLayer.upsertSection(...)`
 * and the `upsertDocumentFromMarkdown(...)` wrapper that delegates to the core) parse
 * via the CommonMark parser for structural splitting but do not run the
 * milkdown serializer round-trip, so normalization here is genuinely
 * additive for that path.
 */
async function writeBodyFile(entry: FlatEntry, content: string): Promise<void> {
  if (entry.isSubSkeleton) return;
  const normalized = jsonToMarkdown(markdownToJSON(content));
  await mkdir(path.dirname(entry.absolutePath), { recursive: true });
  await writeFile(entry.absolutePath, normalized, "utf8");
}

function resolveDocSkeletonPath(contentRoot: string, docPath: string): string {
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return path.resolve(contentRoot, ...normalized.split("/"));
}

async function copyDirectoryRecursive(srcDir: string, destDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // No sections dir is valid
    throw err;
  }
  await mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
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

function buildRewriteReplacementRoots(
  targetParentPath: readonly string[],
  parsedSections: ReadonlyArray<ParsedMarkdownRewriteSection>,
): {
  replacementRoots: RewriteTreeNode[];
  bodyByResultingHeadingPath: Map<string, string>;
} {
  const replacementRoots: RewriteTreeNode[] = [];
  const bodyByResultingHeadingPath = new Map<string, string>();
  const nodesByParsedHeadingPath = new Map<string, RewriteTreeNode>();

  for (const section of parsedSections) {
    const parsedHeadingPath = [...section.headingPath];
    const parsedKey = headingPathKey(parsedHeadingPath);
    if (nodesByParsedHeadingPath.has(parsedKey)) {
      throw new Error(
        `Parsed markdown contains duplicate heading path [${parsedHeadingPath.join(" > ")}].`,
      );
    }

    const node: RewriteTreeNode = {
      heading: parsedHeadingPath.length === 0 ? "" : section.heading,
      level: section.level,
      sectionFile: parsedHeadingPath.length === 0
        ? generateBeforeFirstHeadingFilename()
        : generateSectionFilename(section.heading),
      children: [],
    };
    nodesByParsedHeadingPath.set(parsedKey, node);

    const resultingHeadingPath = [...targetParentPath, ...parsedHeadingPath];
    bodyByResultingHeadingPath.set(headingPathKey(resultingHeadingPath), section.body);

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

export interface SectionDiscoveryEntry {
  heading: string;
  headingPath: string[];
  absolutePath: string;
  bodySizeBytes: number;
}

export interface UpsertSectionFromMarkdownDetailedResult {
  writtenEntries: FlatEntry[];
  removedEntries: FlatEntry[];
  fragmentKeyRemaps: StructuralMutationPlan["fragmentKeyRemaps"];
  liveReloadEntries: FlatEntry[];
  structureChange: {
    oldEntry: FlatEntry;
    newEntries: FlatEntry[];
  } | null;
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
    skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
      sections.push({ heading, level, sectionFile, headingPath: [...headingPath] });
    });
    return sections;
  }

  /**
   * Return discovery rows for real sections only (no structural/sub-skeleton nodes).
   * Includes the canonical absolute body-file path and body file size in bytes.
   */
  async getSectionDiscoveryList(docPath: string): Promise<SectionDiscoveryEntry[]> {
    const skeleton = await this.readSkeleton(docPath);
    const baseEntries: Array<{ heading: string; headingPath: string[]; absolutePath: string }> = [];
    skeleton.forEachSection((heading, _level, _sectionFile, headingPath, absolutePath) => {
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
    return DocumentSkeleton.fromDisk(docPath, this.contentRoot, this.contentRoot);
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
      return skeleton.requireEntryByHeadingPath(headingPath).absolutePath;
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
      const entry = skeleton.requireEntryByHeadingPath(headingPath);
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
    let entry: FlatEntry;
    try {
      entry = skeleton.requireEntryByHeadingPath(ref.headingPath);
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
   * When headingPath is [], reads ALL sections (entire document).
   * This is a document-level read, not a before-first-heading read.
   * For before-first-heading specifically, use readSection(ref(docPath, [])).
   */
  async readSubtree(
    docPath: string,
    headingPath: string[],
  ): Promise<Array<{ headingPath: string[]; heading: string; level: number; bodyContent: string }>> {
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
   * Read all sections in the document (whole-document enumeration).
   * Use this instead of readSubtree(docPath, []).
   */
  async readAllSubtreeEntries(
    docPath: string,
  ): Promise<Array<{ headingPath: string[]; heading: string; level: number; bodyContent: string }>> {
    const skeleton = await this.readSkeleton(docPath);
    const entries = skeleton.allContentEntries();
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

      const entry = skeleton.findEntryByHeadingPath(ref.headingPath);
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
   * `OverlayContentLayer.upsertSection(...)` (item 225); this
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
   * `OverlayContentLayer.upsertSection(...)` instead.
   */
  async writeSection(
    ref: SectionRef,
    content: string,
  ): Promise<void> {
    const skeleton = await this.readSkeleton(ref.docPath);
    const entry = skeleton.requireEntryByHeadingPath(ref.headingPath);
    // Enforce body-only invariant: strip leading heading if it matches the skeleton entry
    const body = stripHeadingFromFragment(fragmentFromExternalContent(content), entry.level);
    // Guard: reject multi-heading content — canonical writes must not mutate skeleton structure
    const hasHeadings = getParser().containsHeadings(body);
    if (hasHeadings) {
      throw new MultiSectionContentError(
        `Multi-section content passed to writeSection() for (${ref.docPath}, ` +
        `[${ref.headingPath.join(" > ")}]) — embedded heading(s) detected. ` +
        `Use OverlayContentLayer.upsertSection(...) for arbitrary ` +
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

    // Collect body sections via visitor (sync), then read files (async)
    const bodyEntries: Array<{ heading: string; level: number; sectionFile: string; absolutePath: string }> = [];
    skeleton.forEachSection((heading, level, sectionFile, _hp, absolutePath) => {
      bodyEntries.push({ heading, level, sectionFile, absolutePath });
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

      const isBeforeFirstHeading = entry.level === 0 && entry.heading === "";
      if (isBeforeFirstHeading) {
        // BFH: body IS fragment content (strip leading newlines defensively)
        const trimmed = stripLeadingNewlines(content);
        if (trimmed) parts.push(bodyAsFragment(trimmed));
      } else {
        parts.push(buildFragmentContent(content, entry.level, entry.heading));
      }
    }

    return assembleFragments(...parts);
  }
}

// ─── OverlayContentLayer ────────────────────────────────────────

/**
 * OverlayContentLayer — skeleton-aware content layer with required canonical fallback.
 *
 * Owns skeleton loading (overlay-first-then-canonical), structural mutation,
 * and content writes. Callers never see or touch DocumentSkeletonInternal.
 *
 * Per item 191: this class holds NO long-lived writable
 * `DocumentSkeletonInternal` instances. Every method that needs a writable
 * skeleton fresh-loads it via `DocumentSkeletonInternal.mutableFromDisk(...)`
 * (or `persistNewEmptyToOverlay(...)` for create flows). Same-call local
 * variables are allowed; cross-call memoization is not.
 */
export class OverlayContentLayer {
  readonly overlayRoot: string;
  readonly canonicalRoot: string;

  constructor(overlayRoot: string, canonicalRoot: string) {
    this.overlayRoot = overlayRoot;
    this.canonicalRoot = canonicalRoot;
  }

  /**
   * True only for a live document. Missing and tombstoned documents return false.
   */
  async documentExists(docPath: string): Promise<boolean> {
    return (await this.getDocumentState(docPath)) === "live";
  }

  /**
   * Resolve the effective document state across overlay + canonical roots.
   * "tombstone" means the overlay explicitly shadows the doc as pending deletion.
   *
   * Document state is determined by skeleton/tombstone files only.
   * The presence or absence of a before-first-heading section has no effect
   * on document existence. A document with zero sections is valid and "live".
   *
   * Per item 193: this method is a pure overlay-aware disk-state resolver.
   * It always calls `readOverlayDocumentState(...)` against the on-disk
   * overlay/canonical markers and returns that result directly. There is
   * no cache, no fast path, and no in-process memoization to second-guess.
   */
  async getDocumentState(docPath: string): Promise<OverlayDocumentState> {
    return readOverlayDocumentState(docPath, this.overlayRoot, this.canonicalRoot);
  }

  /**
   * Materializes a valid persisted live-empty document in the overlay (item 170).
   *
   * Semantic job: after a successful call, the overlay contains exactly an
   * empty skeleton file for `docPath` and nothing else — no body files, no
   * CRDT/DocumentFragments involvement, no extra writes. Subsequent callers can
   * safely add sections via `upsertSection(...)`.
   *
   * State policy (enforced here, not in the DS layer):
   *   - "missing"   → persist a new live-empty doc
   *   - "live"      → throw "already exists"
   *   - "tombstone" → throw "pending deletion" (resurrection NOT supported)
   *
   * Persistence is delegated to the single blessed factory
   * `DocumentSkeletonInternal.persistNewEmptyToOverlay(...)` (item 166).
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
      throw new Error(`Cannot create document "${docPath}" — it is pending deletion in this overlay.`);
    }
    await DocumentSkeletonInternal.persistNewEmptyToOverlay(
      docPath,
      this.overlayRoot,
    );
  }

  /**
   * Reset an existing live overlay document to the same persisted live-empty
   * shape produced by `createDocument(...)`.
   *
   * Safety ordering matters: write the empty skeleton FIRST so stale section
   * files cannot masquerade as current structure, then remove the old
   * `.sections/` tree.
   */
  private async clearDocumentToLiveEmpty(docPath: string): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this overlay.`);
    }
    if (state === "missing") {
      throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
    }

    const overlaySkeletonPath = resolveSkeletonPath(docPath, this.overlayRoot);
    await DocumentSkeletonInternal.persistNewEmptyToOverlay(docPath, this.overlayRoot);
    await rm(`${overlaySkeletonPath}.sections`, { recursive: true, force: true });
  }

  /**
   * Pure fresh-load helper for an existing writable skeleton. Creates nothing,
   * memoizes nothing. Throws DocumentNotFoundError if the document does not
   * exist or is pending deletion.
   *
   * Per items 176/199: every call resolves overlay-aware document state from
   * disk and then loads via `DocumentSkeletonInternal.mutableFromDisk(...)`
   * (item 107) — a pure read with no implicit write side-effects. There is
   * no cross-call cache. Hidden overlay materialization is NOT performed:
   * the only sanctioned path for materializing a missing document is
   * `createDocument(...)`, which goes through
   * `DocumentSkeletonInternal.persistNewEmptyToOverlay(...)` (item 166).
   */
  private async getWritableSkeleton(docPath: string): Promise<DocumentSkeletonInternal> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this overlay.`);
    }
    if (state === "missing") {
      throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
    }
    return DocumentSkeletonInternal.mutableFromDisk(
      docPath,
      this.overlayRoot,
      this.canonicalRoot,
    );
  }

  private async readSkeleton(docPath: string): Promise<DocumentSkeleton> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this overlay.`);
    }
    if (state === "missing") {
      throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
    }
    return DocumentSkeleton.fromDisk(docPath, this.overlayRoot, this.canonicalRoot);
  }

  /**
   * Return the document's structural tree as DocStructureNode[].
   * Uses overlay+canonical skeleton loading.
   */
  async getDocumentStructure(docPath: string): Promise<DocStructureNode[]> {
    const skeleton = await this.readSkeleton(docPath);
    return skeleton.structure;
  }

  /**
   * Resolve a section file ID to its entry.
   * Uses overlay+canonical skeleton loading.
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
   * Uses overlay+canonical skeleton loading.
   */
  async resolveSectionPath(docPath: string, headingPath: string[]): Promise<string> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      return skeleton.requireEntryByHeadingPath(headingPath).absolutePath;
    } catch (err) {
      throw new SectionNotFoundError((err as Error).message);
    }
  }

  /**
   * Resolve a heading path to its absolute file path and heading level.
   * Uses overlay+canonical skeleton loading.
   */
  async resolveSectionPathWithLevel(docPath: string, headingPath: string[]): Promise<{ absolutePath: string; level: number }> {
    const skeleton = await this.readSkeleton(docPath);
    try {
      const entry = skeleton.requireEntryByHeadingPath(headingPath);
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
   * single sanctioned mutating tombstone path on `OverlayContentLayer` —
   * the deleted readonly `DocumentSkeleton.createTombstone(...)` static is
   * gone. Per item 191 there is no class-level skeleton cache; nothing
   * to invalidate.
   */
  async tombstoneDocument(docPath: string): Promise<string[][]> {
    const skeleton = await DocumentSkeleton.fromDisk(docPath, this.canonicalRoot, this.canonicalRoot);
    const paths: string[][] = [];
    skeleton.forEachSection((_h, _l, _sf, headingPath) => {
      paths.push([...headingPath]);
    });
    await this.tombstoneDocumentExplicit(docPath);
    return paths;
  }

  /**
   * Copy a canonical document skeleton + section files into overlay at a new path.
   * Used by proposal-backed move/rename flows that stage the destination document.
   *
   * Per item 180: this method makes an EXPLICIT policy decision about
   * destination state instead of force-clearing whatever is already there.
   * The previous implementation unconditionally `rm`'d any tombstone at the
   * destination and overwrote any existing skeleton, which silently masked
   * conflicts: if the destination was already live in the overlay (a
   * concurrent staged write) or tombstoned (a pending deletion), the copy
   * would clobber it without warning.
   *
   * Policy:
   *   - destination "missing"   → proceed with the copy
   *   - destination "live"      → throw (refuse to overwrite an existing
   *                               overlay document — caller must resolve
   *                               the conflict explicitly)
   *   - destination "tombstone" → throw (refuse to silently clear a
   *                               pending-deletion marker — caller must
   *                               decide whether to abort the move or
   *                               explicitly drop the tombstone first)
   *
   * This routes the rename/copy flow through the same overlay-aware state
   * resolver used by `createDocument(...)` and `getWritableSkeleton(...)`,
   * so storage semantics no longer drift between methods.
   */
  async copyCanonicalDocumentToOverlay(sourceDocPath: string, destinationDocPath: string): Promise<void> {
    const destinationState = await this.getDocumentState(destinationDocPath);
    if (destinationState === "live") {
      throw new Error(
        `Cannot copy "${sourceDocPath}" → "${destinationDocPath}": destination is already live in the overlay. ` +
        `Resolve the conflict explicitly (delete or rename the existing destination) before retrying.`,
      );
    }
    if (destinationState === "tombstone") {
      throw new Error(
        `Cannot copy "${sourceDocPath}" → "${destinationDocPath}": destination has a pending-deletion tombstone in the overlay. ` +
        `Resolve the conflict explicitly (drop the tombstone or abort the move) before retrying.`,
      );
    }

    const canonicalSrcSkeletonPath = resolveDocSkeletonPath(this.canonicalRoot, sourceDocPath);
    const overlayDestSkeletonPath = resolveDocSkeletonPath(this.overlayRoot, destinationDocPath);

    await mkdir(path.dirname(overlayDestSkeletonPath), { recursive: true });
    await copyFile(canonicalSrcSkeletonPath, overlayDestSkeletonPath);
    await copyDirectoryRecursive(
      `${canonicalSrcSkeletonPath}.sections`,
      `${overlayDestSkeletonPath}.sections`,
    );
  }

  /**
   * Reusable document-level copy primitive (item 295). Copy the EFFECTIVE
   * source document state into the overlay at a new destination path.
   *
   * "Effective source" means overlay-first-then-canonical resolution: the
   * source skeleton file is taken from the overlay if present, otherwise
   * from canonical, and section bodies are merged so that overlay-edited
   * sections take precedence over canonical originals.
   *
   * Implementation strategy: file-level copy via the same primitives used
   * by `copyCanonicalDocumentToOverlay(...)`, plus an overlay-overlay step
   * that lets overlay files clobber the canonical copies that were laid
   * down first. This preserves structure/body state directly without
   * reinterpreting the source as a sequence of user section upserts (per
   * the explicit prohibition in item 293).
   *
   * Destination state policy is the same as `copyCanonicalDocumentToOverlay`:
   *   - "missing"   → proceed
   *   - "live"      → throw (refuse to silently overwrite)
   *   - "tombstone" → throw (refuse to silently clear a pending-deletion)
   *
   * Source state policy:
   *   - "missing"   → throw `DocumentNotFoundError`
   *   - "live"      → proceed
   *   - "tombstone" → throw `DocumentNotFoundError`
   */
  private async copyDocumentToOverlayAtPath(
    sourceDocPath: string,
    destinationDocPath: string,
  ): Promise<void> {
    // Validate source state via the overlay-aware resolver — a tombstoned
    // or missing source must NOT be silently treated as a live-empty doc.
    const sourceState = await this.getDocumentState(sourceDocPath);
    if (sourceState === "tombstone") {
      throw new DocumentNotFoundError(
        `Cannot copy "${sourceDocPath}": pending deletion in this overlay.`,
      );
    }
    if (sourceState === "missing") {
      throw new DocumentNotFoundError(
        `Cannot copy "${sourceDocPath}": document does not exist.`,
      );
    }

    // Validate destination state — same policy as copyCanonicalDocumentToOverlay.
    const destinationState = await this.getDocumentState(destinationDocPath);
    if (destinationState === "live") {
      throw new Error(
        `Cannot copy "${sourceDocPath}" → "${destinationDocPath}": destination is already live in the overlay. ` +
          `Resolve the conflict explicitly (delete or rename the existing destination) before retrying.`,
      );
    }
    if (destinationState === "tombstone") {
      throw new Error(
        `Cannot copy "${sourceDocPath}" → "${destinationDocPath}": destination has a pending-deletion tombstone in the overlay. ` +
          `Resolve the conflict explicitly (drop the tombstone or abort the move) before retrying.`,
      );
    }

    const canonicalSrcSkeletonPath = resolveDocSkeletonPath(this.canonicalRoot, sourceDocPath);
    const overlaySrcSkeletonPath = resolveDocSkeletonPath(this.overlayRoot, sourceDocPath);
    const overlayDestSkeletonPath = resolveDocSkeletonPath(this.overlayRoot, destinationDocPath);

    await mkdir(path.dirname(overlayDestSkeletonPath), { recursive: true });

    // Copy effective skeleton file: overlay if present, canonical otherwise.
    let skeletonCopied = false;
    try {
      await copyFile(overlaySrcSkeletonPath, overlayDestSkeletonPath);
      skeletonCopied = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!skeletonCopied) {
      await copyFile(canonicalSrcSkeletonPath, overlayDestSkeletonPath);
    }

    // Copy section bodies from BOTH layers in canonical-then-overlay order
    // so that overlay edits clobber canonical originals when both exist.
    // copyDirectoryRecursive treats a missing source directory as a no-op
    // (returns silently on ENOENT), so this is safe even when one layer
    // has no .sections directory.
    await copyDirectoryRecursive(
      `${canonicalSrcSkeletonPath}.sections`,
      `${overlayDestSkeletonPath}.sections`,
    );
    await copyDirectoryRecursive(
      `${overlaySrcSkeletonPath}.sections`,
      `${overlayDestSkeletonPath}.sections`,
    );
  }

  /**
   * Dedicated rename/copy semantic API (items 287/297). Rename the
   * effective source document to a new destination path inside this
   * overlay. Owns the full storage/orchestration sequence: validate
   * source/destination state, copy the effective source document to the
   * destination via `copyDocumentToOverlayAtPath(...)`, then tombstone
   * the source via `tombstoneDocumentExplicit(...)`.
   *
   * This is the explicit replacement for the open-coded
   * `tombstoneDocument(...)` + `createDocument(...)` +
   * `readAllSubtreeEntries(...)` + looped `writeSection(...)` pattern
   * that previously lived in `mcp/tools/structural.ts` `rename_document`
   * and the HTTP rename route. Per item 293, that pattern was the wrong
   * abstraction: rename/copy is "preserve an existing effective document
   * at a new path", NOT "user markdown write repeated N times".
   *
   * Per item 303, proposal/git/history orchestration (proposal section
   * metadata updates, ACL checks, response shaping, WS event emission)
   * stays in caller code — this method only owns the reusable overlay
   * mutation primitive.
   *
   * Internal split (item 291): `copyDocumentToOverlayAtPath(...)` and
   * `tombstoneDocumentExplicit(...)` are the internal step methods. The
   * public caller-facing primitive is this single semantic operation.
   */
  async renameDocument(
    sourceDocPath: string,
    destinationDocPath: string,
  ): Promise<void> {
    await this.copyDocumentToOverlayAtPath(sourceDocPath, destinationDocPath);
    await this.tombstoneDocumentExplicit(sourceDocPath);
  }

  async getSectionList(
    docPath: string,
  ): Promise<Array<{ heading: string; level: number; sectionFile: string; headingPath: string[] }>> {
    const skeleton = await this.readSkeleton(docPath);
    const sections: Array<{ heading: string; level: number; sectionFile: string; headingPath: string[] }> = [];
    skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
      sections.push({ heading, level, sectionFile, headingPath: [...headingPath] });
    });
    return sections;
  }

  async readAllSections(docPath: string): Promise<Map<string, SectionBody>> {
    const skeleton = await this.readSkeleton(docPath);
    const result = new Map<string, SectionBody>();
    const readTasks: Array<Promise<void>> = [];

    skeleton.forEachSection((_heading, _level, _sectionFile, headingPath, absolutePath) => {
      readTasks.push(
        (async () => {
          const key = SectionRef.headingKey(headingPath);
          const content = await this.readBodyFromLayers(absolutePath);
          if (content === null) {
            throw new DocumentAssemblyError(
              `Section "${key}" in document "${docPath}" is referenced by the skeleton but has no body file in any layer. ` +
              `This indicates data corruption — the skeleton and section files are out of sync.`,
            );
          }
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
    if (!targetingBfh && !headingProvided) {
      throw new Error(
        `Illegal arguments: targeting a headed section but missing the section heading.`,
      );
    }
  }

  async upsertSection(
    ref: SectionRef,
    heading: string,
    content: string,
    opts?: { contentIsFullMarkdown?: boolean },
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    this.validateUpsertHeadingArgument(ref, heading);

    // Root target: defer wholly to the core, which has its own
    // BFH-vs-document-rewrite dispatch.
    if (ref.headingPath.length === 0) {
      return await this.upsertSectionFromMarkdownCore(ref, content);
    }

    const parsed = getParser().parseDocumentMarkdown(content);
    const firstHeaded = parsed.find((sec) => !(sec.level === 0 && sec.heading === ""));

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
    const existing = skeleton.findEntryByHeadingPath(ref.headingPath);
    if (existing) return existing.level;
    for (let i = ref.headingPath.length - 1; i >= 1; i--) {
      const ancestor = skeleton.findEntryByHeadingPath(ref.headingPath.slice(0, i));
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
    const state = await this.getDocumentState(ref.docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${ref.docPath}" is pending deletion in this overlay.`);
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

    // Root target: defer to the root-safe rewrite primitive directly. The
    // BFH and headed root sections (if any) are described entirely by
    // parsedSections — there is no orphan to split here because the parser
    // already represents leading content as a level-0 root section.
    //
    // Identity short-circuit (item 371) applies to root upserts too: a
    // clean BFH-only re-normalization on a BFH-only document must be a
    // no-op rather than churning the BFH section file id.
    if (ref.headingPath.length === 0) {
      if (opts?.requireMergeToPrevious) {
        const hasHeadedSection = parsedSections.some((sec) => !(sec.level === 0 && sec.heading === ""));
        if (hasHeadedSection) {
          throw new Error(
            `Illegal arguments: upsertSectionMergingToPrevious cannot target BFH with headed markdown content.`,
          );
        }
      }
      if (await this.isIdentityUpsert(skeleton, [], parsedSections)) {
        return {
          writtenEntries: [],
          removedEntries: [],
          fragmentKeyRemaps: [],
          liveReloadEntries: [],
          structureChange: null,
        };
      }

      // ── BUG2-followup-A — BFH-only payload body-update branch ──────────
      //
      // The semantic ambiguity: `headingPath=[]` is overloaded. For
      // `upsertDocumentFromMarkdown(...)` it means "rewrite the whole
      // document". But for a single-fragment normalize of the BFH key, it
      // means "this fragment carries only the BFH section's body". The
      // dispatch can't tell the cases apart from the parsed payload alone,
      // but it CAN tell them apart by checking whether the parsed payload
      // is BFH-only AND the live skeleton already has headed sections.
      //
      // Without this branch, normalizing a BFH fragment routes through
      // `rewriteSubtreeFromParsedMarkdown([])` which rewrites the whole
      // document with one BFH-only section, destroying every headed
      // section. See `targeted-normalization-sequential-matrix.test.ts >
      // sequential normalization should be idempotent on second pass`.
      const isBfhOnlyPayload =
        parsedSections.length === 1
        && parsedSections[0].level === 0
        && parsedSections[0].heading === "";
      if (
        isBfhOnlyPayload
        && skeleton.allContentEntries().some((e) => e.headingPath.length > 0)
      ) {
        const bfhEntry = skeleton.findEntryByHeadingPath([]);
        if (bfhEntry) {
          // Body identity check: if the BFH body already matches the
          // payload byte-for-byte, return the same empty-change shape that
          // `isIdentityUpsert` would have produced. This makes second-pass
          // normalize a true no-op for clean BFH-only fragments.
          const currentBody = bodyFromDisk(
            (await this.readBodyFromLayers(bfhEntry.absolutePath)) ?? "",
          );
          if ((currentBody as string) === (parsedSections[0].body as unknown as string)) {
            return {
              writtenEntries: [],
              removedEntries: [],
              fragmentKeyRemaps: [],
              liveReloadEntries: [],
              structureChange: null,
            };
          }
          await this.writeOverlayBodyFile(
            ref.docPath,
            bfhEntry,
            parsedSections[0].body as unknown as string,
          );
          return {
            writtenEntries: [bfhEntry],
            removedEntries: [],
            fragmentKeyRemaps: [],
            liveReloadEntries: [bfhEntry],
            structureChange: null,
          };
        }
        // No BFH entry exists yet — fall through to the rewrite path so
        // BFH auto-creation still works for the legitimate "upsert root
        // markdown into a doc that doesn't have a BFH yet" case.
      }

      return await this.rewriteSubtreeFromParsedMarkdown(
        ref.docPath,
        [],
        parsedSections,
      );
    }

    // Non-root target: split off the leading level-0 orphan, if any. The
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
    // heading with body-only text. Delegate to the existing delete-and-
    // absorb primitive; its `.trim()` guard suppresses the merge-target
    // write when the orphan body is empty, so the "user truly emptied
    // everything" and "user replaced heading with whitespace" cases land
    // in the same code path.
    if (headedSections.length === 0) {
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
      const entry = skeleton.requireEntryByHeadingPath(ref.headingPath);
      if (single.heading === entry.heading && single.level === entry.level) {
        // Body-only update on a sub-skeleton parent. requireEntryByHeadingPath
        // already collapsed to the body-holder child, so writing entry's
        // absolutePath updates the parent's own body without touching any
        // descendant section.
        await this.writeOverlayBodyFile(
          ref.docPath,
          entry,
          single.body as unknown as string,
        );
        return {
          writtenEntries: [entry],
          removedEntries: [],
          fragmentKeyRemaps: [],
          liveReloadEntries: [entry],
          structureChange: null,
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
        writtenEntries: [newEntry],
        removedEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [newEntry],
        structureChange: {
          oldEntry,
          newEntries: [newEntry],
        },
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
        removedEntries: [],
        fragmentKeyRemaps: [],
        liveReloadEntries: [],
        structureChange: null,
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
      const entry = skeleton.requireEntryByHeadingPath(ref.headingPath);
      if (single.heading === entry.heading && single.level === entry.level) {
        const writtenEntries: FlatEntry[] = [entry];
        const liveReloadEntries: FlatEntry[] = [entry];

        if (hasOrphan) {
          const prevHolder = skeleton.findPreviousBodyHolder(entry.sectionFile);
          if (prevHolder) {
            const existing = bodyFromDisk(
              (await this.readBodyFromLayers(prevHolder.absolutePath)) ?? "",
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
          removedEntries: [],
          fragmentKeyRemaps: [],
          liveReloadEntries,
          structureChange: null,
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
   * Algorithm:
   *   1. Walk skeleton.subtreeEntries(headingPath) — the inclusive
   *      content subtree, excluding sub-skeleton structural nodes.
   *   2. Bail if cardinalities mismatch.
   *   3. For each parsed section, translate its parser-relative heading
   *      path to absolute by prepending headingPath.slice(0, -1), look up
   *      the live entry via findEntryByHeadingPath (which collapses
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
    if (parsedSections.length === 0) return false;

    // For root target use allContentEntries (subtreeEntries throws on []);
    // for any other target use the inclusive subtree.
    const liveEntries = headingPath.length === 0
      ? skeleton.allContentEntries()
      : skeleton.subtreeEntries(headingPath);
    if (liveEntries.length !== parsedSections.length) return false;

    const parentPrefix = headingPath.length === 0 ? [] : headingPath.slice(0, -1);
    for (const parsed of parsedSections) {
      const absoluteHeadingPath = [...parentPrefix, ...parsed.headingPath];
      const liveEntry = skeleton.findEntryByHeadingPath(absoluteHeadingPath);
      if (!liveEntry) return false;
      if (liveEntry.heading !== parsed.heading) return false;
      if (liveEntry.level !== parsed.level) return false;
      const liveBody = bodyFromDisk(
        (await this.readBodyFromLayers(liveEntry.absolutePath)) ?? "",
      );
      if ((liveBody as string) !== (parsed.body as unknown as string)) return false;
    }
    return true;
  }

  /**
   * Whole-document upsert-from-markdown primitive (items 307, 354, 355).
   *
   * Item 355 reduced this to a THIN storage wrapper. The semantic is now
   * literally "clear/create doc to a live-empty state, then upsert the
   * root section from arbitrary markdown" — i.e. the same `*FromMarkdown`
   * upsert family used by the section-upsert core with the
   * special target `headingPath=[]`.
   *
   * The method must NOT:
   *   - parse markdown (the inner upsert core call owns parse/classify)
   *   - load canonical skeletons
   *   - call any document-level parsed-markdown replace helper
   *   - return caller-reactive structural metadata
   *
   * Per items 307/309/313/354/355 the contract is intentionally narrow:
   *   - Returns nothing — there is no caller-reactive structural metadata.
   *     Callers that need a section-target list (e.g. for proposal metadata
   *     updates) must read it back via `listHeadingPaths(...)` after the
   *     write completes.
   *   - Owns ONLY storage orchestration: state validation, clear-or-create,
   *     and delegation to the section-upsert primitive. Does NOT touch
   *     proposal creation, proposal section metadata, ACL checks, git
   *     commit/restore trailers, or HTTP/MCP response shaping.
   *
   * State policy:
   *   - "missing"   → `createDocument(...)` (produces a live-empty doc)
   *   - "live"      → `clearDocumentToLiveEmpty(...)` (item 356 helper —
   *                   removes all overlay skeleton/body state for the doc
   *                   and leaves it in the same live-empty shape that
   *                   `createDocument(...)` produces)
   *   - "tombstone" → throw `DocumentNotFoundError("pending deletion")`
   *
   * After the clear-or-create step the document is always in live-empty
   * state, so the subsequent root upsert call
   * call writes the entire payload as a fresh root upsert. This is exactly
   * the path item 357 makes legal (it had previously been blocked by the
   * `headingPath=[]` rejection in `rewriteSubtreeFromParsedMarkdown(...)`).
   *
   * Per items 309/311 this method replaces the previous (broken)
   * `importMarkdownDocument(...)` whose name implied "bring in something
   * new" but whose actual semantic was "replace whatever is at this path
   * with the contents of this markdown payload". Item 354 renamed this
   * from `replaceDocumentFromMarkdown(...)` to capture the new mental model.
   */
  async upsertDocumentFromMarkdown(
    docPath: string,
    markdown: string,
  ): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this overlay.`);
    }
    if (state === "missing") {
      await this.createDocument(docPath);
    } else {
      // state === "live": clear the overlay copy to a live-empty shape so
      // the subsequent root upsert starts from a known-empty state. This
      // is the one non-trivial part of overwrite semantics — see item 356.
      await this.clearDocumentToLiveEmpty(docPath);
    }

    // Delegate to the parser-driven core at the unnamed root target.
    await this.upsertSectionFromMarkdownCore(new SectionRef(docPath, []), markdown);
  }

  // ─── Structural mutations ─────────────────────────────────

  // The private `createSection(...)` helper was deleted per item 434. It had
  // zero production callers (item 273 audit), zero remaining test callers
  // after item 430 migrated `insert-section-body-holder.test.ts` to drive
  // `upsertSection(...)`, and was a duplicate of the buggy
  // leaf→sub-skeleton transition path that item 432 fixed once-and-for-all
  // inside `materializeAncestorHeadings(...)`. All callers that previously
  // wanted "create a structural target then write a body" now go through
  // `OverlayContentLayer.upsertSection(...)`.

  // ─── Read methods (delegated to readonly paths) ───────────

  async readSection(ref: SectionRef): Promise<SectionBody> {
    const skeleton = await this.readSkeleton(ref.docPath);
    const entry = skeleton.requireEntryByHeadingPath(ref.headingPath);
    const content = await this.readBodyFromLayers(entry.absolutePath);
    if (content === null) {
      throw new SectionNotFoundError(`Section not found in any layer for "${ref.docPath}" [${ref.headingPath.join(" > ")}]`);
    }
    return bodyFromDisk(content);
  }

  // ─── Private helpers ──────────────────────────────────────

  private async readBodyFromLayers(overlayPath: string): Promise<string | null> {
    try {
      return await readFile(overlayPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const canonicalPath = path.join(
      this.canonicalRoot,
      path.relative(this.overlayRoot, overlayPath),
    );
    try {
      return await readFile(canonicalPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return null;
  }

  /**
   * Write-path invariant gate:
   * a real overlay body write must never occur before the overlay skeleton
   * exists for that document.
   *
   * This intentionally does NOT run on read paths.
   */
  private async ensureOverlaySkeletonForWrite(docPath: string): Promise<void> {
    if (this.overlayRoot === this.canonicalRoot) return;
    if (await skeletonFileExists(docPath, this.overlayRoot)) return;

    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this overlay.`);
    }
    if (state === "missing") {
      throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
    }

    const skeleton = await DocumentSkeletonInternal.mutableFromDisk(
      docPath,
      this.overlayRoot,
      this.canonicalRoot,
    );
    await skeleton.materializeOverlayIfMissing();
  }

  private async writeOverlayBodyFile(
    docPath: string,
    entry: FlatEntry,
    content: string,
  ): Promise<void> {
    await this.ensureOverlaySkeletonForWrite(docPath);
    await writeBodyFile(entry, content);
  }

  private async deleteSectionAndAbsorbOrphanBody(
    skeleton: DocumentSkeletonInternal,
    headingPath: string[],
    body: SectionBody,
  ): Promise<UpsertSectionFromMarkdownDetailedResult> {
    const deletedEntry = skeleton.requireEntryByHeadingPath(headingPath);
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
        (await this.readBodyFromLayers(deletion.mergeTarget.absolutePath)) ?? "",
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
      removedEntries: deletion.removed.filter((e) => !e.isSubSkeleton),
      fragmentKeyRemaps: deletion.fragmentKeyRemaps,
      liveReloadEntries: deletion.mergeTargetWasCreated || (orphanBody as string).trim()
        ? [deletion.mergeTarget]
        : [],
      structureChange: {
        oldEntry: deletedEntry,
        newEntries: [],
      },
    };
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
        const bfhIdx = ctx.roots.findIndex((n) => n.level === 0 && n.heading === "");
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
  ): Promise<FlatEntry> {
    if (headingPath.length === 0) {
      throw new Error(
        `Cannot rename the before-first-heading section in ${docPath} — it has no heading.`,
      );
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    const oldEntry = skeleton.requireEntryByHeadingPath(headingPath);
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
    const oldBody = (await this.readBodyFromLayers(oldEntry.absolutePath)) ?? "";

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const parentPath = headingPath.slice(0, -1);
      const target = headingPath[headingPath.length - 1];
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot rename");
      }

      const oldNode = siblings[idx];
      const parentSkeletonPath = ctx.resolveSkeletonPathFor(parentPath);
      const removed = ctx.flattenNode(oldNode, parentPath, parentSkeletonPath);

      const newSectionFile = generateSectionFilename(newHeading);
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
        fragmentKeyRemaps: [{ from: oldNode.sectionFile, to: newSectionFile }],
      } satisfies StructuralMutationPlan;
    });

    // Perform the body writes and deletions declared in the plan.
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
    const newEntry = plan.added.find((e) => !e.isSubSkeleton);
    if (!newEntry) {
      throw new Error(`renameHeading produced no content entry in ${docPath}`);
    }
    return newEntry;
  }

  private async retitleSubSkeletonParentInPlace(
    skeleton: DocumentSkeletonInternal,
    docPath: string,
    headingPath: string[],
    newHeading: string,
    newLevel: number,
  ): Promise<{ oldEntry: FlatEntry; newEntry: FlatEntry }> {
    if (headingPath.length === 0) {
      throw new Error(
        `Cannot retitle the before-first-heading section in ${docPath} — it has no heading.`,
      );
    }

    const oldEntry = skeleton.requireEntryByHeadingPath(headingPath);
    const parentPath = headingPath.slice(0, -1);
    const target = headingPath[headingPath.length - 1];
    await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => headingsEqual(n.heading, target));
      if (idx < 0) {
        throw staleHeadingPath(docPath, headingPath, "cannot retitle sub-skeleton parent");
      }
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
    const newEntry = skeleton.requireEntryByHeadingPath(newHeadingPath);
    return { oldEntry, newEntry };
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
      preBodies.set(relKey, (await this.readBodyFromLayers(entry.absolutePath)) ?? "");
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
      const removed = ctx.flattenNode(movedNode, parentPath, ctx.resolveSkeletonPathFor(parentPath));
      sourceSiblings.splice(sourceIdx, 1);

      // Retarget the moved node to the new level and file id.
      const relabeled: SkeletonNode = {
        heading: movedNode.heading,
        level: newLevel,
        sectionFile: generateSectionFilename(movedNode.heading),
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
        fragmentKeyRemaps: [{ from: movedNode.sectionFile, to: relabeled.sectionFile }],
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
   * Rewrite the subtree at `headingPath` from a pre-parsed markdown section
   * list, preserving the targeted slot in its parent.
   *
   * The parsed section list is interpreted structurally via its parsed
   * `headingPath` relationships, not by ad hoc level bucketing. `headingPath=[]`
   * is legal here and means "rewrite the unnamed root/BFH target" just like
   * any other section target.
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
    const skeleton = await this.getWritableSkeleton(docPath);
    const targetEntry = skeleton.findEntryByHeadingPath(headingPath);
    if (!targetEntry) {
      throw staleHeadingPath(docPath, headingPath, "cannot rewrite");
    }

    const parentPath = headingPath.slice(0, -1);
    const { replacementRoots, bodyByResultingHeadingPath } = buildRewriteReplacementRoots(
      parentPath,
      parsedSections,
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
      preMutationMergeTarget = skeleton.findPreviousBodyHolder(targetEntry.sectionFile);
      if (preMutationMergeTarget) {
        existingMergeBody = bodyFromDisk(
          (await this.readBodyFromLayers(preMutationMergeTarget.absolutePath)) ?? "",
        );
      }
    }

    const plan = await skeleton.applyStructuralMutationTransaction((ctx) => {
      const siblings = ctx.findSiblingList(parentPath);
      const idx = siblings.findIndex((n) => n.sectionFile === targetEntry.sectionFile);
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

      return {
        removed,
        added,
        bodyWrites,
        fragmentKeyRemaps: [{ from: oldNode.sectionFile, to: replacementRoots[0]?.sectionFile ?? null }],
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
      removedEntries: plan.removed.filter((e) => !e.isSubSkeleton),
      fragmentKeyRemaps: plan.fragmentKeyRemaps,
      liveReloadEntries,
      structureChange: {
        oldEntry: targetEntry,
        newEntries: addedNonSub,
      },
    };
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
      const entry = skeleton.requireEntryByHeadingPath(leafParentPath);
      leafParentBody = bodyFromDisk((await this.readBodyFromLayers(entry.absolutePath)) ?? "");
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

      for (let i = 1; i <= headingPath.length; i++) {
        const ancestorPath = headingPath.slice(0, i);
        if (skeleton.has(ancestorPath)) continue;
        const parentPath = ancestorPath.slice(0, -1);
        const parentSiblings = ctx.findSiblingList(parentPath);
        const level = parentPath.length === 0
          ? 1
          : skeleton.requireEntryByHeadingPath(parentPath).level + 1;
        const heading = ancestorPath[ancestorPath.length - 1];
        const node: SkeletonNode = {
          heading,
          level,
          sectionFile: generateSectionFilename(heading),
          children: [],
        };
        parentSiblings.push(node);
        newlyAdded.push(
          ...ctx.flattenNode(node, parentPath, ctx.resolveSkeletonPathFor(parentPath)),
        );
      }

      // Body-holder materialization for the captured leaf parent. After the
      // loop above the parent has gained its first real child but no body
      // holder yet — addBodyHoldersToParents prepends a level-0/heading=""
      // child whose file will hold the parent's pre-migration body content.
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
        const bhEntry: FlatEntry = {
          headingPath: [...leafParentPath],
          heading: "",
          level: 0,
          sectionFile: bh.sectionFile,
          absolutePath: bhAbsolutePathForMigration,
          isSubSkeleton: false,
        };
        newlyAdded.push(bhEntry);
      }

      const bodyWrites: StructuralMutationPlan["bodyWrites"] = [];
      for (const e of newlyAdded) {
        if (e.isSubSkeleton) continue;
        const isMigratedBh =
          leafParentPath !== null && e.absolutePath === bhAbsolutePathForMigration;
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
    const overlaySkeletonPath = resolveSkeletonPath(docPath, this.overlayRoot);
    const tombstonePath = resolveTombstonePath(docPath, this.overlayRoot);
    await mkdir(path.dirname(tombstonePath), { recursive: true });
    await rm(overlaySkeletonPath, { force: true });
    await rm(`${overlaySkeletonPath}.sections`, { recursive: true, force: true });
    await writeFile(
      tombstonePath,
      `This file marks file ${normalizeDocPath(docPath)} to be deleted when this proposal is committed\n`,
      "utf8",
    );
  }
}
