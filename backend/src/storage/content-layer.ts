/**
 * ContentLayer — Uniform interface for reading/writing section content
 * from a content root directory.
 *
 * Constructed from a single contentRoot path. Supports overlay-first-then-
 * canonical reads via an optional fallback ContentLayer.
 *
 * One class, no subclasses. Compose two instances to get overlay behavior:
 *
 *   const canonical = new ContentLayer(getContentRoot());
 *   const overlay = new ContentLayer(getSessionDocsContentRoot(), canonical);
 *   // overlay.readSection() tries overlay root first, falls back to canonical
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { DocumentSkeleton, type FlatEntry } from "./document-skeleton.js";
import { ParsedDocument } from "./markdown-sections.js";
import type { DocStructureNode } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";

export class SectionNotFoundError extends Error {}
export class DocumentNotFoundError extends Error {}
export class DocumentAssemblyError extends Error {}
export class MultiSectionContentError extends Error {}

import { getParser } from "./markdown-parser.js";

/**
 * Strip a leading heading line if it matches the skeleton entry's heading text and level.
 * No-op for root sections (level=0, heading="") and for content that is already body-only.
 * Idempotent: body-only input passes through unchanged.
 */
function stripMatchingHeading(content: string, level: number, heading: string): string {
  // Root sections never have headings to strip
  if (level === 0 && heading === "") return content;

  const expectedPrefix = "#".repeat(level) + " " + heading;
  const lines = content.split("\n");
  if (lines.length === 0 || lines[0] !== expectedPrefix) return content;

  // Strip heading line and any blank lines after it
  let startIdx = 1;
  while (startIdx < lines.length && lines[startIdx].trim() === "") {
    startIdx++;
  }
  return lines.slice(startIdx).join("\n");
}

export class ContentLayer {
  readonly contentRoot: string;
  private readonly fallback: ContentLayer | undefined;

  constructor(contentRoot: string, fallback?: ContentLayer) {
    this.contentRoot = contentRoot;
    this.fallback = fallback;
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
   * Read the DocumentSkeleton for a document.
   *
   * When a fallback is configured, the skeleton is loaded with
   * overlay-first-then-canonical semantics (DocumentSkeleton.fromDisk
   * already supports this via its overlayRoot/canonicalRoot parameters).
   *
   * When no fallback is configured, both roots point to this.contentRoot
   * (pure canonical read).
   */
  private async readSkeleton(docPath: string): Promise<DocumentSkeleton> {
    const canonicalRoot = this.fallback?.contentRoot ?? this.contentRoot;
    return DocumentSkeleton.fromDisk(docPath, this.contentRoot, canonicalRoot);
  }

  /**
   * Read a single section's body content.
   *
   * Resolves (docPath, headingPath) → section file via the skeleton,
   * reads the file under this layer's contentRoot. If the file doesn't
   * exist and a fallback is configured, delegates to the fallback.
   */
  async readSection(ref: SectionRef): Promise<string> {
    const skeleton = await this.readSkeleton(ref.docPath);
    let entry: FlatEntry;
    try {
      entry = skeleton.resolve(ref.headingPath);
    } catch (err) {
      if (this.fallback) return this.fallback.readSection(ref);
      throw new SectionNotFoundError((err as Error).message);
    }

    try {
      return await readFile(entry.absolutePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // File not on disk at this layer — try fallback
      if (this.fallback) return this.fallback.readSection(ref);
      throw new SectionNotFoundError(
        `Section not found: (${ref.docPath}, [${ref.headingPath.join(" > ")}]).`,
      );
    }
  }

  /**
   * Read the full subtree rooted at headingPath: the section itself and all
   * descendants. Reads body content via readSection (respects overlay fallback).
   * headingPath=[] returns all sections in the document.
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
        entry = skeleton.resolve(ref.headingPath);
      } catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith("Skeleton integrity error")) throw e;
        // Section not in skeleton — try fallback
        if (this.fallback) {
          try {
            const content = await this.fallback.readSection(ref);
            result.set(ref.globalKey, content);
          } catch (fe) { if (!(fe instanceof SectionNotFoundError)) throw fe; }
        }
        continue;
      }

      try {
        const content = await readFile(entry.absolutePath, "utf8");
        result.set(ref.globalKey, content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // Try fallback
        if (this.fallback) {
          try {
            const content = await this.fallback.readSection(ref);
            result.set(ref.globalKey, content);
          } catch (fe) { if (!(fe instanceof SectionNotFoundError)) throw fe; }
        }
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
    const entry = skeleton.resolve(ref.headingPath);
    // Enforce body-only invariant: strip leading heading if it matches the skeleton entry
    const body = stripMatchingHeading(content, entry.level, entry.heading);
    // Guard: reject multi-heading content that should go through importMarkdownDocument
    const hasHeadings = getParser().containsHeadings(body);
    if (hasHeadings) {
      throw new MultiSectionContentError(
        `Multi-section content passed to writeSection() for (${ref.docPath}, ` +
        `[${ref.headingPath.join(" > ")}]) — embedded heading(s) detected. ` +
        `Use importMarkdownDocument() instead.`,
      );
    }
    await mkdir(path.dirname(entry.absolutePath), { recursive: true });
    await writeFile(entry.absolutePath, body, "utf8");
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
  async importMarkdownDocument(
    docPath: string,
    markdown: string,
  ): Promise<Array<{ doc_path: string; heading_path: string[] }>> {
    const canonicalRoot = this.fallback?.contentRoot ?? this.contentRoot;
    const parsed = new ParsedDocument(markdown);

    // Load canonical skeleton for file-ID matching; empty skeleton for new docs
    let canonicalSkeleton: DocumentSkeleton;
    try {
      canonicalSkeleton = await DocumentSkeleton.fromDisk(docPath, canonicalRoot, canonicalRoot);
    } catch {
      canonicalSkeleton = DocumentSkeleton.createEmpty(docPath, canonicalRoot);
    }

    // Build overlay skeleton — correct matching algorithm, no position fallback
    const overlaySkeleton = canonicalSkeleton.buildOverlaySkeleton(parsed, this.contentRoot);

    // Collect overlay entries in document order (same order as parsed.sections)
    const overlayPaths: string[] = [];
    overlaySkeleton.forEachSection((_heading, _level, _sectionFile, _headingPath, absolutePath) => {
      overlayPaths.push(absolutePath);
    });

    // Write body files: both lists are in the same document order
    for (let i = 0; i < parsed.sections.length && i < overlayPaths.length; i++) {
      const absolutePath = overlayPaths[i];
      const trimmedBody = parsed.sections[i].body.replace(/\n+$/, "");
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, trimmedBody ? trimmedBody + "\n" : "", "utf8");
    }

    // Write skeleton file
    await overlaySkeleton.persist();

    return parsed.sectionTargets(docPath);
  }

  /**
   * Read all sections for a document, unioning overlay and canonical skeletons.
   *
   * Approach 2: loads two independent skeletons (overlay-only via
   * fromDisk(docPath, overlayRoot, overlayRoot) and canonical-only via
   * fromDisk(docPath, canonicalRoot, canonicalRoot)), builds a union of
   * heading keys with both absolute paths, then fires all readFile calls
   * in parallel with overlay preference.
   *
   * Returns Map keyed by headingKey (e.g. "Heading A>>Sub B").
   *
   * FUTURE (Approach 4): If merge ordering or structural metadata becomes
   * needed beyond content reads, introduce a SkeletonMergedView value object
   * that pairs two DocumentSkeleton instances and provides a unified iteration.
   */
  async readAllSections(docPath: string): Promise<Map<string, string>> {
    const overlayRoot = this.contentRoot;
    const canonicalRoot = this.fallback?.contentRoot ?? this.contentRoot;

    // Load each skeleton independently — not through the merged overlay path
    interface PathPair { overlayPath: string | null; canonicalPath: string | null }
    const union = new Map<string, PathPair>();

    try {
      const overlaySkeleton = await DocumentSkeleton.fromDisk(docPath, overlayRoot, overlayRoot);
      overlaySkeleton.forEachSection((_h, _l, _sf, headingPath, absolutePath) => {
        const key = SectionRef.headingKey(headingPath);
        const existing = union.get(key);
        if (existing) {
          existing.overlayPath = absolutePath;
        } else {
          union.set(key, { overlayPath: absolutePath, canonicalPath: null });
        }
      });
    } catch (e) { if (!(e instanceof DocumentNotFoundError)) throw e; }

    try {
      const canonicalSkeleton = await DocumentSkeleton.fromDisk(docPath, canonicalRoot, canonicalRoot);
      canonicalSkeleton.forEachSection((_h, _l, _sf, headingPath, absolutePath) => {
        const key = SectionRef.headingKey(headingPath);
        const existing = union.get(key);
        if (existing) {
          existing.canonicalPath = absolutePath;
        } else {
          union.set(key, { overlayPath: null, canonicalPath: absolutePath });
        }
      });
    } catch (e) { if (!(e instanceof DocumentNotFoundError)) throw e; }

    // Read all files in parallel, preferring overlay
    const result = new Map<string, string>();
    const readTasks: Array<Promise<void>> = [];

    for (const [key, paths] of union) {
      readTasks.push(
        (async () => {
          // Try overlay first
          if (paths.overlayPath) {
            try {
              result.set(key, await readFile(paths.overlayPath, "utf8"));
              return;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
              // Overlay file missing — fall through to canonical
            }
          }
          // Fall back to canonical
          if (paths.canonicalPath) {
            try {
              result.set(key, await readFile(paths.canonicalPath, "utf8"));
              return;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            }
          }
          // Both overlay and canonical missing — skeleton references a file that doesn't exist
          throw new DocumentAssemblyError(
            `Section "${key}" in document "${docPath}" is referenced by the skeleton but has no body file in any layer. ` +
            `This indicates data corruption — the skeleton and section files are out of sync.`,
          );
        })(),
      );
    }

    await Promise.all(readTasks);
    return result;
  }

  /**
   * Assemble a complete document from skeleton + section body files.
   *
   * Reads all non-sub-skeleton entries from the skeleton in document order,
   * concatenates their body content. Each section is read through this
   * layer's read path (with fallback if configured).
   */
  async readAssembledDocument(docPath: string): Promise<string> {
    const skeleton = await this.readSkeleton(docPath);

    // Collect body sections via visitor (sync), then read files (async)
    const bodyEntries: Array<{ heading: string; level: number; sectionFile: string; absolutePath: string }> = [];
    skeleton.forEachSection((heading, level, sectionFile, _hp, absolutePath) => {
      bodyEntries.push({ heading, level, sectionFile, absolutePath });
    });

    if (bodyEntries.length === 0) {
      throw new DocumentNotFoundError(`No skeleton found for document: ${docPath}`);
    }

    const parts: string[] = [];

    for (const entry of bodyEntries) {
      let content: string | undefined;
      try {
        content = await readFile(entry.absolutePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // Try fallback for this specific file
        if (this.fallback) {
          const relativePath = path.relative(this.contentRoot, entry.absolutePath);
          const fallbackPath = path.join(this.fallback.contentRoot, relativePath);
          try {
            content = await readFile(fallbackPath, "utf8");
          } catch (err2) {
            if ((err2 as NodeJS.ErrnoException).code !== "ENOENT") throw err2;
          }
        }
        if (content === undefined) {
          throw new DocumentAssemblyError(
            `Skeleton integrity check failed for "${docPath}": section file "${entry.sectionFile}" is referenced by the skeleton but has no body file in any layer. This indicates data corruption.`,
          );
        }
      }

      if (content === undefined) continue;

      // Prepend heading for non-root sections
      const isRoot = entry.level === 0 && entry.heading === "";
      if (!isRoot) {
        const headingLine = `${"#".repeat(entry.level)} ${entry.heading}`;
        const trimmed = content.replace(/^\n+/, "").replace(/\n+$/, "");
        parts.push(trimmed ? `${headingLine}\n\n${trimmed}\n` : `${headingLine}\n`);
      } else {
        const trimmedRoot = content.replace(/^\n+/, "").replace(/\n+$/, "");
        if (trimmedRoot) parts.push(trimmedRoot);
      }
    }

    return parts.join("\n");
  }
}
