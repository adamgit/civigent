/**
 * ContentLayer — Uniform interface for reading/writing section content
 * from a content root directory.
 *
 * Constructed from a single contentRoot path and used for canonical-only
 * reads/writes. Overlay+canonical behavior lives in OverlayContentLayer.
 */

import { readFile, writeFile, mkdir, copyFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  DocumentSkeleton,
  DocumentSkeletonInternal,
  readOverlayDocumentState,
  resolveTombstonePath,
  skeletonFileExists,
  type FlatEntry,
  type OverlayDocumentState,
  type ReplacementResult,
} from "./document-skeleton.js";
import { ParsedDocument } from "./markdown-sections.js";
import type { DocStructureNode } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";
import { markdownToJSON, jsonToMarkdown } from "@ks/milkdown-serializer";
import { prependHeading, bodyFromDisk, stripHeadingFromFragment, type SectionBody, type FragmentContent } from "./section-formatting.js";

/**
 * Write a section body file, creating parent directories as needed.
 * No-op for sub-skeleton entries (their files are skeleton listings, not body content).
 *
 * All content is normalized via a markdownToJSON→jsonToMarkdown round-trip
 * before writing to disk. This is the single normalization gate — every
 * write path (MCP write_section, importMarkdownDocument, createSection,
 * moveSection, renameSection, crash recovery) passes through here.
 *
 * The CRDT flush path (FragmentStore.extractMarkdown) inherently normalizes
 * as a side-effect of Y.Doc→markdown serialization via jsonToMarkdown, so
 * content from that path is already normalized — the second pass here is a
 * no-op because the round-trip is idempotent. This double-application is
 * unavoidable because extractMarkdown cannot produce markdown without
 * jsonToMarkdown (it's the serialization step, not an optional normalization),
 * and we cannot skip normalization here because all other write paths do not
 * normalize. importMarkdownDocument uses ParsedDocument for structural
 * splitting (CommonMark heading detection) but does not run the milkdown
 * serializer round-trip, so normalization here is genuinely additive for
 * that path.
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

export class SectionNotFoundError extends Error {}
export class DocumentNotFoundError extends Error {}
export class DocumentAssemblyError extends Error {}
export class MultiSectionContentError extends Error {}

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
      return skeleton.expect(headingPath).absolutePath;
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
      const entry = skeleton.expect(headingPath);
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
      const entry = skeleton.expectByFileId(sectionFileId);
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
      entry = skeleton.expect(ref.headingPath);
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

      let entry: FlatEntry;
      try {
        entry = skeleton.expect(ref.headingPath);
      } catch {
        continue;
      }

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
   * Write a section's body content to this layer's contentRoot.
   *
   * Resolves the heading path via the skeleton and writes the content
   * to the resolved file path. Creates parent directories as needed.
   *
   * Throws if the content contains multiple markdown headings — use
   * importMarkdownDocument() for multi-section content.
   */
  async writeSection(
    ref: SectionRef,
    content: string,
  ): Promise<void> {
    const skeleton = await this.readSkeleton(ref.docPath);
    const entry = skeleton.expect(ref.headingPath);
    // Enforce body-only invariant: strip leading heading if it matches the skeleton entry
    const body = stripHeadingFromFragment(content as FragmentContent, entry.level) as string;
    // Guard: reject multi-heading content that should go through importMarkdownDocument
    const hasHeadings = getParser().containsHeadings(body);
    if (hasHeadings) {
      throw new MultiSectionContentError(
        `Multi-section content passed to writeSection() for (${ref.docPath}, ` +
        `[${ref.headingPath.join(" > ")}]) — embedded heading(s) detected. ` +
        `Use importMarkdownDocument() instead.`,
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

    const parts: string[] = [];

    for (const entry of bodyEntries) {
      let content: string | undefined;
      try {
        content = await readFile(entry.absolutePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        throw new DocumentAssemblyError(
          `Skeleton integrity check failed for "${docPath}": section file "${entry.sectionFile}" is referenced by the skeleton but has no body file in the active layer. This indicates data corruption.`,
          { cause: err },
        );
      }

      if (content === undefined) continue;

      // Prepend heading for non-before-first-heading sections
      const isBeforeFirstHeading = entry.level === 0 && entry.heading === "";
      if (!isBeforeFirstHeading) {
        parts.push(prependHeading(content, entry.level, entry.heading));
      } else {
        const trimmedRoot = content.replace(/^\n+/, "").replace(/\n+$/, "");
        if (trimmedRoot) parts.push(trimmedRoot);
      }
    }

    return parts.join("\n");
  }
}

// ─── OverlayContentLayer ────────────────────────────────────────

/**
 * OverlayContentLayer — skeleton-aware content layer with required canonical fallback.
 *
 * Owns skeleton loading (overlay-first-then-canonical), structural mutation,
 * and content writes. Callers never see or touch DocumentSkeletonInternal.
 *
 * Skeleton instances are cached per docPath for the lifetime of this layer,
 * so multiple writeSection + structural calls for the same document share
 * one skeleton and don't redundantly read from disk.
 */
export class OverlayContentLayer {
  readonly overlayRoot: string;
  readonly canonicalRoot: string;
  private skeletonCache = new Map<string, DocumentSkeletonInternal>();

  constructor(overlayRoot: string, canonicalRoot: string) {
    this.overlayRoot = overlayRoot;
    this.canonicalRoot = canonicalRoot;
  }

  /** Normalize docPath for cache key consistency (strip leading slashes/backslashes). */
  private cacheKey(docPath: string): string {
    return docPath.replace(/\\/g, "/").replace(/^\/+/, "");
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
   */
  async getDocumentState(docPath: string): Promise<OverlayDocumentState> {
    if (this.skeletonCache.has(this.cacheKey(docPath))) return "live";
    return readOverlayDocumentState(docPath, this.overlayRoot, this.canonicalRoot);
  }

  /**
   * Creates a live-empty document (zero sections, zero body files).
   * The skeleton file is persisted immediately, marking the document as "live".
   * Sections are added later via writeSection() or createSection().
   */
  async createDocument(docPath: string): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state === "live") {
      throw new Error(`Cannot create document "${docPath}" — it already exists.`);
    }
    if (state === "tombstone") {
      throw new Error(`Cannot create document "${docPath}" — it is pending deletion in this overlay.`);
    }
    const skeleton = DocumentSkeletonInternal.inMemoryEmpty(docPath, this.overlayRoot);
    await skeleton.persistInternal();
    this.skeletonCache.set(this.cacheKey(docPath), skeleton);
  }

  /**
   * Return a cached or disk-loaded writable skeleton. Creates nothing.
   * Throws DocumentNotFoundError if the document does not exist.
   */
  async getWritableSkeleton(docPath: string): Promise<DocumentSkeletonInternal> {
    const cached = this.skeletonCache.get(this.cacheKey(docPath));
    if (cached) return cached;
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this overlay.`);
    }
    if (state === "missing") {
      throw new DocumentNotFoundError(`Document "${docPath}" does not exist.`);
    }
    const skeleton = await DocumentSkeletonInternal.fromDisk(docPath, this.overlayRoot, this.canonicalRoot);
    this.skeletonCache.set(this.cacheKey(docPath), skeleton);
    return skeleton;
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
      const entry = skeleton.expectByFileId(sectionFileId);
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
      return skeleton.expect(headingPath).absolutePath;
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
      const entry = skeleton.expect(headingPath);
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
    return DocumentSkeleton.sectionsDir(docPath, this.canonicalRoot);
  }

  /**
   * List all heading paths from canonical, then write a tombstone marker
   * to the overlay. Returns the heading paths (for building proposal metadata).
   */
  async tombstoneDocument(docPath: string): Promise<string[][]> {
    const skeleton = await DocumentSkeleton.fromDisk(docPath, this.canonicalRoot, this.canonicalRoot);
    const paths: string[][] = [];
    skeleton.forEachSection((_h, _l, _sf, headingPath) => {
      paths.push([...headingPath]);
    });
    await DocumentSkeleton.createTombstone(docPath, this.overlayRoot);
    this.skeletonCache.delete(this.cacheKey(docPath));
    return paths;
  }

  /**
   * Copy a canonical document skeleton + section files into overlay at a new path.
   * Used by proposal-backed move/rename flows that stage the destination document.
   */
  async copyCanonicalDocumentToOverlay(sourceDocPath: string, destinationDocPath: string): Promise<void> {
    const canonicalSrcSkeletonPath = resolveDocSkeletonPath(this.canonicalRoot, sourceDocPath);
    const overlayDestSkeletonPath = resolveDocSkeletonPath(this.overlayRoot, destinationDocPath);

    await rm(resolveTombstonePath(destinationDocPath, this.overlayRoot), { force: true });
    await mkdir(path.dirname(overlayDestSkeletonPath), { recursive: true });
    await copyFile(canonicalSrcSkeletonPath, overlayDestSkeletonPath);
    await copyDirectoryRecursive(
      `${canonicalSrcSkeletonPath}.sections`,
      `${overlayDestSkeletonPath}.sections`,
    );
    this.skeletonCache.delete(this.cacheKey(destinationDocPath));
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

  /**
   * Write a section's body content. Auto-creates the document and any missing
   * ancestor headings if they don't exist in the skeleton.
   *
   * Level for auto-created headings is parent.level + 1.
   */
  async writeSection(ref: SectionRef, content: string): Promise<void> {
    const state = await this.getDocumentState(ref.docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${ref.docPath}" is pending deletion in this overlay.`);
    }
    if (state === "missing") {
      await this.createDocument(ref.docPath);
    }
    const skeleton = await this.getWritableSkeleton(ref.docPath);

    // Auto-create missing ancestor headings
    await this.ensureAncestorHeadings(skeleton, ref.headingPath);

    const entry = skeleton.expect(ref.headingPath);
    // Strip leading heading if it matches the skeleton entry
    const body = stripHeadingFromFragment(content as FragmentContent, entry.level) as string;
    // Guard: reject multi-heading content that should go through importMarkdownDocument
    const hasHeadings = getParser().containsHeadings(body);
    if (hasHeadings) {
      throw new MultiSectionContentError(
        `Multi-section content passed to writeSection() for (${ref.docPath}, ` +
        `[${ref.headingPath.join(" > ")}]) — embedded heading(s) detected. ` +
        `Use importMarkdownDocument() instead.`,
      );
    }

    await writeBodyFile(entry, body);

  }

  /**
   * Import a full assembled markdown document. Delegates to the same
   * normalize-on-write path as ContentLayer.importMarkdownDocument.
   */
  async importMarkdownDocument(
    docPath: string,
    markdown: string,
  ): Promise<Array<{ doc_path: string; heading_path: string[] }>> {
    if ((await this.getDocumentState(docPath)) === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this overlay.`);
    }
    const parsed = new ParsedDocument(markdown);

    // Load canonical skeleton for file-ID matching; in-memory empty for new docs
    let canonicalSkeleton: DocumentSkeletonInternal;
    try {
      canonicalSkeleton = await DocumentSkeletonInternal.fromDisk(docPath, this.canonicalRoot, this.canonicalRoot);
    } catch {
      canonicalSkeleton = DocumentSkeletonInternal.inMemoryEmpty(docPath, this.overlayRoot);
    }

    const overlaySkeleton = await canonicalSkeleton.buildOverlaySkeleton(parsed, this.overlayRoot);

    const overlayEntries: FlatEntry[] = [];
    overlaySkeleton.forEachSection((_heading, _level, sectionFile, headingPath, absolutePath) => {
      overlayEntries.push({ headingPath: [...headingPath], heading: _heading, level: _level, sectionFile, absolutePath, isSubSkeleton: false });
    });

    for (let i = 0; i < parsed.sections.length && i < overlayEntries.length; i++) {
      const trimmedBody = parsed.sections[i].body.replace(/\n+$/, "");
      await writeBodyFile(overlayEntries[i], trimmedBody ? trimmedBody + "\n" : "");
    }

    this.skeletonCache.set(this.cacheKey(docPath), overlaySkeleton);

    return parsed.sectionTargets(docPath);
  }

  // ─── Structural mutations ─────────────────────────────────

  /**
   * Create a new section under parentPath. Writes an empty body file and
   * updates the skeleton atomically (skeleton persisted after body write).
   */
  async createSection(
    docPath: string,
    parentPath: string[],
    heading: string,
    level: number,
    body: string = "",
  ): Promise<FlatEntry[]> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this overlay.`);
    }
    if (state === "missing") {
      await this.createDocument(docPath);
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    const added = await skeleton.insertSectionUnder(parentPath, { heading, level, body });

    // Write body file for each added entry (may include root children for sub-skeletons)
    for (const entry of added) {
      await writeBodyFile(entry, body);
    }

    return added;
  }

  /**
   * Delete a section by heading path. Removes the section from the skeleton
   * and persists atomically.
   */
  async deleteSection(
    docPath: string,
    headingPath: string[],
  ): Promise<ReplacementResult> {
    const skeleton = await this.getWritableSkeleton(docPath);
    const result = await skeleton.replace(headingPath, []);
    return result;
  }

  /**
   * Move a section from one location to another.
   * Removes from old location, inserts under new parent, preserves body content.
   */
  async moveSection(
    docPath: string,
    headingPath: string[],
    newParentPath: string[],
    newLevel: number,
  ): Promise<{ removed: FlatEntry[]; added: FlatEntry[] }> {
    const skeleton = await this.getWritableSkeleton(docPath);

    // Read body content before removal
    const entry = skeleton.expect(headingPath);
    let bodyContent = "";
    try {
      bodyContent = await readFile(entry.absolutePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    // Remove from old position
    const { removed } = await skeleton.replace(headingPath, []);

    // Insert at new position
    const heading = headingPath[headingPath.length - 1];
    const added = await skeleton.insertSectionUnder(newParentPath, {
      heading,
      level: newLevel,
      body: bodyContent,
    });

    // Write body file at new location
    for (const addedEntry of added) {
      await writeBodyFile(addedEntry, bodyContent);
    }

    return { removed, added };
  }

  /**
   * Rename a section (change heading text). Preserves body content.
   */
  /**
   * Create the before-first-heading section explicitly. Throws if it already exists.
   */
  async createBeforeFirstHeadingSection(docPath: string, body: string): Promise<void> {
    const state = await this.getDocumentState(docPath);
    if (state === "tombstone") {
      throw new DocumentNotFoundError(`Document "${docPath}" is pending deletion in this overlay.`);
    }
    if (state === "missing") {
      await this.createDocument(docPath);
    }
    const skeleton = await this.getWritableSkeleton(docPath);
    if (skeleton.has([])) {
      throw new Error(`Before-first-heading section already exists in "${docPath}".`);
    }
    const added = await skeleton.insertSectionUnder([], {
      heading: "",
      level: 0,
      body: "",
    });
    for (const entry of added) {
      await writeBodyFile(entry, body);
    }
  }

  async renameSection(
    docPath: string,
    headingPath: string[],
    newHeading: string,
  ): Promise<ReplacementResult> {
    if (headingPath.length === 0) {
      throw new Error("Cannot rename the before-first-heading section — it has no heading.");
    }
    const skeleton = await this.getWritableSkeleton(docPath);

    // Read body content before replacement
    const entry = skeleton.expect(headingPath);
    let bodyContent = "";
    try {
      bodyContent = await readFile(entry.absolutePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const result = await skeleton.replace(headingPath, [{
      heading: newHeading,
      level: entry.level,
      body: bodyContent,
    }]);

    // Write body file at new location
    for (const addedEntry of result.added) {
      await writeBodyFile(addedEntry, bodyContent);
    }

    return result;
  }

  /**
   * Create a tombstone marker for document deletion.
   */
  async deleteDocument(docPath: string): Promise<void> {
    await DocumentSkeleton.createTombstone(docPath, this.overlayRoot);
    this.skeletonCache.delete(this.cacheKey(docPath));
  }

  // ─── Read methods (delegated to readonly paths) ───────────

  async readSection(ref: SectionRef): Promise<SectionBody> {
    const skeleton = await this.readSkeleton(ref.docPath);
    const entry = skeleton.expect(ref.headingPath);
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
   * Ensure all headings in the path exist. Auto-creates missing ancestors.
   * Level for each auto-created heading is parent.level + 1.
   */
  private async ensureAncestorHeadings(
    skeleton: DocumentSkeletonInternal,
    headingPath: string[],
  ): Promise<void> {
    // Auto-create before-first-heading section if targeting [] and skeleton has none
    if (headingPath.length === 0 && !skeleton.has([])) {
      const added = await skeleton.insertSectionUnder([], {
        heading: "",
        level: 0,
        body: "",
      });
      for (const entry of added) {
        await writeBodyFile(entry, "");
      }
    }
    for (let i = 1; i <= headingPath.length; i++) {
      const ancestorPath = headingPath.slice(0, i);
      if (skeleton.has(ancestorPath)) continue;

      const parentPath = ancestorPath.slice(0, -1);
      const parentLevel = parentPath.length === 0
        ? 0
        : skeleton.expect(parentPath).level;
      const level = parentLevel + 1;
      const heading = ancestorPath[ancestorPath.length - 1];

      const added = await skeleton.insertSectionUnder(parentPath, {
        heading,
        level,
        body: "",
      });

      // Write empty body files for auto-created entries
      for (const entry of added) {
        await writeBodyFile(entry, "");
      }
    }
  }
}
