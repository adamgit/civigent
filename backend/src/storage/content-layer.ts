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
import { DocumentSkeleton, type FlatEntry, generateSectionFilename, serializeSkeletonEntries } from "./document-skeleton.js";
import { parseDocumentMarkdown } from "./markdown-sections.js";
import { sectionGlobalKey } from "../types/shared.js";
import { SectionRef } from "../domain/section-ref.js";

export class SectionNotFoundError extends Error {}
export class DocumentNotFoundError extends Error {}
export class DocumentAssemblyError extends Error {}
export class MultiSectionContentError extends Error {}

const HEADING_RE = /^#{1,6}\s+.+$/;

/**
 * Strip a leading heading line if it matches the skeleton entry's heading text and level.
 * No-op for root sections (level=0, heading="") and for content that is already body-only.
 * Idempotent: body-only input passes through unchanged.
 */
export function stripMatchingHeading(content: string, level: number, heading: string): string {
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
   * Read the DocumentSkeleton for a document.
   *
   * When a fallback is configured, the skeleton is loaded with
   * overlay-first-then-canonical semantics (DocumentSkeleton.fromDisk
   * already supports this via its overlayRoot/canonicalRoot parameters).
   *
   * When no fallback is configured, both roots point to this.contentRoot
   * (pure canonical read).
   */
  async readSkeleton(docPath: string): Promise<DocumentSkeleton> {
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
      } catch {
        // Section not in skeleton — try fallback
        if (this.fallback) {
          try {
            const content = await this.fallback.readSection(ref);
            result.set(ref.globalKey, content);
          } catch { /* missing in fallback too — skip */ }
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
          } catch { /* missing in fallback too — skip */ }
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
   * writeAssembledDocument() for multi-section content.
   */
  async writeSection(
    ref: SectionRef,
    content: string,
  ): Promise<void> {
    const skeleton = await this.readSkeleton(ref.docPath);
    const entry = skeleton.resolve(ref.headingPath);
    // Enforce body-only invariant: strip leading heading if it matches the skeleton entry
    const body = stripMatchingHeading(content, entry.level, entry.heading);
    // Guard: reject multi-heading content that should go through writeAssembledDocument
    const headingLineCount = body.split("\n").filter(l => HEADING_RE.test(l.trim())).length;
    if (headingLineCount > 0) {
      throw new MultiSectionContentError(
        `Multi-section content passed to writeSection() for (${ref.docPath}, ` +
        `[${ref.headingPath.join(" > ")}]) — found ${headingLineCount} embedded heading(s). ` +
        `Use writeAssembledDocument() instead.`,
      );
    }
    await mkdir(path.dirname(entry.absolutePath), { recursive: true });
    await writeFile(entry.absolutePath, body, "utf8");
  }

  /**
   * Write a full assembled markdown document, normalizing into per-section files.
   *
   * Parses the markdown into sections, creates/updates the skeleton to match
   * the heading structure, and writes per-section body files. This is the
   * single authoritative normalize-on-write path for multi-section content.
   *
   * Returns the list of section targets (docPath + headingPath) for all
   * sections that were written, suitable for building proposal metadata.
   */
  async writeAssembledDocument(
    docPath: string,
    markdown: string,
  ): Promise<Array<{ doc_path: string; heading_path: string[] }>> {
    const canonicalRoot = this.fallback?.contentRoot ?? this.contentRoot;
    const parsedSections = parseDocumentMarkdown(markdown);

    // Load existing skeleton (from canonical via fallback, or empty)
    let canonicalSkeleton: DocumentSkeleton;
    try {
      canonicalSkeleton = await DocumentSkeleton.fromDisk(docPath, canonicalRoot, canonicalRoot);
    } catch {
      canonicalSkeleton = DocumentSkeleton.createEmpty(docPath, canonicalRoot);
    }

    // Collect canonical flat entries for matching
    const canonicalFlat: Array<FlatEntry> = [];
    canonicalSkeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
      canonicalFlat.push({
        headingPath: [...headingPath], heading, level, sectionFile, absolutePath, isSubSkeleton: false,
      });
    });

    // Build skeleton path and sections dir for this layer
    const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const skeletonPath = path.resolve(this.contentRoot, ...normalized.split("/"));
    const sectionsDir = `${skeletonPath}.sections`;

    // Match parsed sections to canonical entries (by heading text, then position)
    const consumed = new Set<number>();
    let topLevelIndex = 0;
    const newEntries: Array<{ heading: string; level: number; sectionFile: string }> = [];
    const sectionTargets: Array<{ doc_path: string; heading_path: string[] }> = [];

    for (const section of parsedSections) {
      const isRoot = section.headingPath.length === 0;
      const heading = section.heading;

      // Try matching by heading text (case-insensitive)
      let matchedIdx = -1;
      if (isRoot) {
        for (let ci = 0; ci < canonicalFlat.length; ci++) {
          if (consumed.has(ci)) continue;
          if (canonicalFlat[ci].level === 0 && canonicalFlat[ci].heading === "") {
            matchedIdx = ci;
            break;
          }
        }
      } else {
        for (let ci = 0; ci < canonicalFlat.length; ci++) {
          if (consumed.has(ci)) continue;
          if (canonicalFlat[ci].heading.toLowerCase() === heading.toLowerCase()) {
            matchedIdx = ci;
            break;
          }
        }
      }

      // Position-based fallback for renamed headings
      if (!isRoot && matchedIdx < 0 && topLevelIndex < canonicalFlat.length && !consumed.has(topLevelIndex)) {
        matchedIdx = topLevelIndex;
      }

      if (matchedIdx >= 0) consumed.add(matchedIdx);
      if (!isRoot) topLevelIndex++;

      const sectionFile = matchedIdx >= 0
        ? canonicalFlat[matchedIdx].sectionFile
        : generateSectionFilename(isRoot ? "root" : heading);

      newEntries.push({
        heading: isRoot ? "" : heading,
        level: section.level,
        sectionFile,
      });

      // Write body file
      const sectionPath = path.join(sectionsDir, sectionFile);
      await mkdir(path.dirname(sectionPath), { recursive: true });
      const trimmedBody = section.body.replace(/\n+$/, "");
      await writeFile(sectionPath, trimmedBody ? trimmedBody + "\n" : "", "utf8");

      sectionTargets.push({
        doc_path: docPath,
        heading_path: [...section.headingPath],
      });
    }

    // Write skeleton file
    const skeletonContent = serializeSkeletonEntries(newEntries);
    await mkdir(path.dirname(skeletonPath), { recursive: true });
    await writeFile(skeletonPath, skeletonContent, "utf8");

    return sectionTargets;
  }

  /**
   * Parallel batch read: like readSectionBatch but fires all readFile calls
   * concurrently via Promise.all instead of sequential for-of await.
   */
  async readSectionBatchParallel(
    sections: SectionRef[],
  ): Promise<Map<string, string>> {
    const skeletonCache = new Map<string, DocumentSkeleton>();
    const result = new Map<string, string>();

    // Pre-load skeletons (sequential — typically 1-2 unique docs)
    for (const ref of sections) {
      if (!skeletonCache.has(ref.docPath)) {
        skeletonCache.set(ref.docPath, await this.readSkeleton(ref.docPath));
      }
    }

    // Fire all reads in parallel
    const readTasks = sections.map(async (ref) => {
      const skeleton = skeletonCache.get(ref.docPath)!;
      let entry: FlatEntry;
      try {
        entry = skeleton.resolve(ref.headingPath);
      } catch {
        if (this.fallback) {
          try {
            const content = await this.fallback.readSection(ref);
            result.set(ref.globalKey, content);
          } catch { /* missing in fallback too */ }
        }
        return;
      }

      try {
        const content = await readFile(entry.absolutePath, "utf8");
        result.set(ref.globalKey, content);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        if (this.fallback) {
          try {
            const content = await this.fallback.readSection(ref);
            result.set(ref.globalKey, content);
          } catch { /* missing in fallback too */ }
        }
      }
    });

    await Promise.all(readTasks);
    return result;
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
  async readAllSectionsOverlaid(docPath: string): Promise<Map<string, string>> {
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
    } catch { /* overlay skeleton doesn't exist */ }

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
    } catch { /* canonical skeleton doesn't exist */ }

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
            }
          }
          // Fall back to canonical
          if (paths.canonicalPath) {
            try {
              result.set(key, await readFile(paths.canonicalPath, "utf8"));
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            }
          }
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
    const missingSections: string[] = [];

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
            missingSections.push(entry.sectionFile);
          }
        } else {
          missingSections.push(entry.sectionFile);
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

    if (missingSections.length > 0) {
      throw new DocumentAssemblyError(
        `Skeleton integrity check failed for "${docPath}": ${missingSections.length} missing section file(s): ${missingSections.join(", ")}`,
      );
    }

    return parts.join("\n");
  }
}
