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
  DocumentSkeleton,
  type FlatEntry,
  serializeSkeletonEntries,
  generateSectionFilename,
} from "./document-skeleton.js";

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

// ─── Heading regex ───────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

// ─── parseDocumentMarkdown ───────────────────────────────────────

/**
 * Split a full assembled markdown document into sections by heading boundaries.
 *
 * Each section includes its heading line as the first line and all content
 * until the next heading of equal or higher level (lower depth number).
 *
 * Returns a flat list of ParsedSection in document order. The root section
 * (content before the first heading) is included with headingPath=[].
 */
export function parseDocumentMarkdown(markdown: string): ParsedSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: ParsedSection[] = [];

  // Track current heading context as a stack of {heading, level}
  let currentLines: string[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  const headingStack: Array<{ heading: string; level: number }> = [];

  function flushSection(): void {
    const fullContent = currentLines.join("\n");
    const body = currentHeading
      ? currentLines.slice(1).join("\n").replace(/^\n+/, "")
      : fullContent;

    const headingPath = headingStack.map((h) => h.heading);

    sections.push({
      headingPath: [...headingPath],
      heading: currentHeading,
      level: currentLevel,
      body: body.replace(/\n+$/, ""),
      fullContent: fullContent.replace(/\n+$/, ""),
    });
  }

  for (const line of lines) {
    const headingMatch = HEADING_RE.exec(line.trim());

    if (headingMatch) {
      // Flush the previous section
      if (currentLines.length > 0 || sections.length === 0) {
        if (currentLines.length > 0) {
          flushSection();
        }
      }

      const newLevel = headingMatch[1].length;
      const newHeading = headingMatch[2].trim();

      // Pop stack back to parent level
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= newLevel) {
        headingStack.pop();
      }
      headingStack.push({ heading: newHeading, level: newLevel });

      currentLines = [line];
      currentHeading = newHeading;
      currentLevel = newLevel;
    } else {
      currentLines.push(line);
    }
  }

  // Flush last section
  if (currentLines.length > 0) {
    flushSection();
  }

  return sections;
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

  // Load canonical skeleton via DocumentSkeleton
  const canonicalSkeleton = await DocumentSkeleton.fromDisk(docPath, contentRoot, contentRoot);
  const canonicalFlat: FlatEntry[] = [];
  canonicalSkeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
    canonicalFlat.push({ headingPath: [...headingPath], heading, level, sectionFile, absolutePath, isSubSkeleton: false });
  });

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
    const isRoot = section.headingPath.length === 0;
    const heading = section.heading;

    // 1. Try matching by heading text (case-insensitive)
    let matchedEntry: FlatEntry | undefined;
    if (isRoot) {
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
    if (!isRoot && !matchedEntry && topLevelIndex < canonicalFlat.length && !consumed.has(topLevelIndex)) {
      matchedEntry = canonicalFlat[topLevelIndex];
      consumed.add(topLevelIndex);
    }

    if (!isRoot) topLevelIndex++;

    const sectionFile = matchedEntry?.sectionFile ?? generateSectionFilename(isRoot ? "root" : heading);

    newEntries.push({ heading: isRoot ? "" : heading, level: section.level, sectionFile });

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
} from "./document-skeleton.js";