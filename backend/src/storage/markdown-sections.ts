/**
 * Markdown Section Parsing & Draft Application
 *
 * parseDocumentMarkdown — splits an assembled markdown document into sections
 * by heading boundaries (the inverse of readAssembledDocument).
 *
 * applyDocumentMarkdownToDraft — writes parsed sections to a draft/session
 * directory, only writing files that differ from canonical. Handles
 * structural changes (heading renames, section creation/deletion) by
 * updating skeleton files.
 */

import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { getContentRoot } from "./data-root.js";
import {
  type FlatEntry,
  serializeSkeletonEntries,
  generateSectionFilename,
  generateBeforeFirstHeadingFilename,
} from "./document-skeleton.js";
import { ContentLayer } from "./content-layer.js";

// ─── Types ───────────────────────────────────────────────────────

export interface ParsedSection {
  /** Heading path segments, e.g. ["Overview"] or ["Getting Started", "Installation"] */
  headingPath: string[];
  /** The heading text (without # prefix) */
  heading: string;
  /** Heading depth (1-6) */
  level: number;
  /** Section body content (everything after the heading line, trimmed) */
  body: string;
  /** Full content including heading line */
  fullContent: string;
}

export interface ApplyResult {
  /** Section targets that were written (changed from canonical) */
  changedTargets: Array<{ headingPath: string[]; sectionFile: string }>;
  /** Heading renames detected: oldHeading → newHeading */
  headingRenames: Array<{ oldPath: string[]; newPath: string[] }>;
  /** Whether the skeleton was modified */
  skeletonChanged: boolean;
}

// ─── parseDocumentMarkdown ───────────────────────────────────────

import { getParser } from "./markdown-parser.js";

/**
 * Split a full assembled markdown document into sections by heading boundaries.
 *
 * Delegates to the code-fence-aware CommonMark parser. Heading-like lines inside
 * fenced code blocks, indented code blocks, and HTML blocks are correctly ignored.
 * Setext headings (underline style) are recognized.
 */
export function parseDocumentMarkdown(markdown: string): ParsedSection[] {
  return getParser().parseDocumentMarkdown(markdown);
}

// ─── ParsedDocument ──────────────────────────────────────────────

/**
 * A parsed markdown document as a first-class value.
 *
 * Wraps parseDocumentMarkdown and exposes the resulting sections as a
 * typed, immutable list. Can be passed around and acted on without
 * repeating the parse step.
 */
export class ParsedDocument {
  readonly sections: ReadonlyArray<ParsedSection>;

  constructor(markdown: string) {
    this.sections = parseDocumentMarkdown(markdown);
  }

  /**
   * Return the proposal section manifest for this document: one entry per
   * section in document order, ready for use as a section target list.
   */
  sectionTargets(docPath: string): Array<{ doc_path: string; heading_path: string[] }> {
    return this.sections.map(s => ({ doc_path: docPath, heading_path: s.headingPath }));
  }
}

// ─── applyDocumentMarkdownToDraft ────────────────────────────────

/**
 * Write an assembled markdown document's sections to a draft directory,
 * mirroring the canonical skeleton + section file structure.
 *
 * Only writes files that differ from canonical. Detects structural changes
 * (heading renames, additions, deletions) and updates skeleton files.
 *
 * @param docPath - Document path (e.g., "docs/guide.md")
 * @param markdown - Full assembled markdown content
 * @param draftRoot - Root directory for draft output (e.g., sessions/docs/content/)
 * @returns ApplyResult describing what changed
 */
export async function applyDocumentMarkdownToDraft(
  docPath: string,
  markdown: string,
  draftRoot: string,
): Promise<ApplyResult> {
  const contentRoot = getContentRoot();
  const parsedSections = parseDocumentMarkdown(markdown);
  const result: ApplyResult = {
    changedTargets: [],
    headingRenames: [],
    skeletonChanged: false,
  };

  // Load canonical skeleton via ContentLayer
  const layer = new ContentLayer(contentRoot);
  const sectionList = await layer.getSectionList(docPath);
  const sectionsDir = layer.sectionsDirectory(docPath);
  const canonicalFlat: FlatEntry[] = sectionList.map(s => ({
    headingPath: s.headingPath,
    heading: s.heading,
    level: s.level,
    sectionFile: s.sectionFile,
    absolutePath: path.join(sectionsDir, s.sectionFile),
    isSubSkeleton: false,
  }));

  // Build the draft skeleton path
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const draftSkeletonPath = path.resolve(draftRoot, ...normalized.split("/"));
  const draftSectionsDir = `${draftSkeletonPath}.sections`;

  // Track consumed canonical entries for position-based rename matching
  const consumed = new Set<number>();
  let topLevelIndex = 0;

  // Build new skeleton entries for comparison and draft writing
  const newEntries: Array<{ heading: string; level: number; sectionFile: string }> = [];

  for (const section of parsedSections) {
    const isBeforeFirstHeading = section.headingPath.length === 0;
    const heading = section.heading;

    // 1. Try matching by heading text (case-insensitive)
    let matchedEntry: FlatEntry | undefined;
    if (isBeforeFirstHeading) {
      for (let ci = 0; ci < canonicalFlat.length; ci++) {
        if (consumed.has(ci)) continue;
        if (canonicalFlat[ci].level === 0 && canonicalFlat[ci].heading === "") {
          matchedEntry = canonicalFlat[ci];
          consumed.add(ci);
          break;
        }
      }
    } else {
      for (let ci = 0; ci < canonicalFlat.length; ci++) {
        if (consumed.has(ci)) continue;
        if (canonicalFlat[ci].heading.toLowerCase() === heading.toLowerCase()) {
          matchedEntry = canonicalFlat[ci];
          consumed.add(ci);
          break;
        }
      }
    }

    // 2. Position-based fallback: if no text match, the heading at
    //    this position was likely renamed. Reuse the canonical section
    //    filename so the session overlay file keeps the same path.
    if (!isBeforeFirstHeading && !matchedEntry && topLevelIndex < canonicalFlat.length && !consumed.has(topLevelIndex)) {
      matchedEntry = canonicalFlat[topLevelIndex];
      consumed.add(topLevelIndex);
    }

    if (!isBeforeFirstHeading) topLevelIndex++;

    const sectionFile = matchedEntry?.sectionFile ?? (isBeforeFirstHeading ? generateBeforeFirstHeadingFilename() : generateSectionFilename(heading));

    newEntries.push({ heading: isBeforeFirstHeading ? "" : heading, level: section.level, sectionFile });

    // Read canonical section content for comparison
    let canonicalBody = "";
    if (matchedEntry) {
      try {
        canonicalBody = (await readFile(matchedEntry.absolutePath, "utf8")).replace(/\n+$/, "");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    // Compare and write if different
    const sectionBody = section.body;
    if (sectionBody !== canonicalBody || !matchedEntry) {
      const draftSectionPath = path.join(draftSectionsDir, sectionFile);
      await mkdir(path.dirname(draftSectionPath), { recursive: true });
      await writeFile(draftSectionPath, sectionBody + "\n", "utf8");
      result.changedTargets.push({ headingPath: section.headingPath, sectionFile });
    }
  }

  // Check if skeleton structure changed by comparing entries
  const structureChanged =
    newEntries.length !== canonicalFlat.length ||
    newEntries.some((ne, i) =>
      ne.heading !== canonicalFlat[i].heading ||
      ne.level !== canonicalFlat[i].level ||
      ne.sectionFile !== canonicalFlat[i].sectionFile
    );

  if (structureChanged) {
    result.skeletonChanged = true;
    // Write draft skeleton using serializeSkeletonEntries
    const newSkeletonContent = serializeSkeletonEntries(newEntries);
    await mkdir(path.dirname(draftSkeletonPath), { recursive: true });
    await writeFile(draftSkeletonPath, newSkeletonContent, "utf8");

    // Detect heading renames by comparing ordered entries with same sectionFile
    for (let i = 0; i < Math.min(canonicalFlat.length, newEntries.length); i++) {
      if (
        canonicalFlat[i].sectionFile === newEntries[i].sectionFile &&
        canonicalFlat[i].heading !== newEntries[i].heading
      ) {
        result.headingRenames.push({
          oldPath: [canonicalFlat[i].heading],
          newPath: [newEntries[i].heading],
        });
      }
    }
  }

  return result;
}

// Re-export skeleton helpers from their canonical home in document-skeleton.ts
// for backward compatibility with existing importers.
export {
  type SkeletonEntry,
  parseSkeletonToEntries,
  serializeSkeletonEntries,
  generateSectionFilename,
  generateBeforeFirstHeadingFilename,
  generateSectionBodyFilename,
} from "./document-skeleton.js";