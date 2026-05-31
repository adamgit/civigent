/**
 * Skeleton & section-content assessment — tolerant diagnostic readers.
 *
 * Salvaged from the deleted `recovery-layers.ts` recovery module. These two
 * helpers never throw on corrupt/missing/truncated input — they report what they
 * could and could not read. They are consumed only by document-diagnostics
 * (skeleton-match / section-parseable checks), NOT by crash recovery: `sessions/`
 * is no longer a durable surface and recovery no longer reconstructs canonical
 * from session/overlay/raw-fragment layers (spec `05` › Crash Recovery).
 */

import { readFile, readdir } from "node:fs/promises";
import { parseSkeletonToEntries, type SkeletonEntry } from "./document-skeleton.js";

// ─── Skeleton Assessment ──────────────────────────────────────────

export interface SkeletonAssessment {
  /** Entries successfully parsed from this layer's skeleton file */
  entries: SkeletonEntry[];
  /** Whether parsing completed without throwing */
  parsedCleanly: boolean;
  /** If parsing threw, the error (for logging, never re-thrown) */
  parseError?: Error;
  /** All .md files found in this layer's .sections/ directory */
  filesOnDisk: string[];
  /** Files on disk not referenced by any parsed entry */
  unreferencedFiles: string[];
  /** True when entries account for all files on disk AND parsed cleanly */
  complete: boolean;
}

/**
 * Assess a skeleton file and its associated sections directory.
 * Never throws. If readFile fails, parsedCleanly=false and entries=[].
 * The filesystem scan always runs regardless.
 */
export async function assessSkeleton(
  skeletonPath: string,
  sectionsDir: string,
): Promise<SkeletonAssessment> {
  // Read and parse skeleton file
  let entries: SkeletonEntry[] = [];
  let parsedCleanly = false;
  let parseError: Error | undefined;

  try {
    const raw = await readFile(skeletonPath, "utf8");
    entries = parseSkeletonToEntries(raw);
    parsedCleanly = true;
  } catch (err) {
    parseError = err instanceof Error ? err : new Error(String(err));
  }

  // Scan sections directory for all .md files
  let filesOnDisk: string[] = [];
  try {
    const dirEntries = await readdir(sectionsDir);
    filesOnDisk = dirEntries.filter((f) => f.endsWith(".md")).sort();
  } catch { // Intentional: tolerant assessment contract — never throws
    // ENOENT or other — no files on disk
  }

  // Compute unreferenced files
  const referencedFiles = new Set(entries.map((e) => e.sectionFile));
  const unreferencedFiles = filesOnDisk.filter((f) => !referencedFiles.has(f));

  const complete = parsedCleanly && unreferencedFiles.length === 0 && entries.length > 0;

  return {
    entries,
    parsedCleanly,
    parseError,
    filesOnDisk,
    unreferencedFiles,
    complete,
  };
}

// ─── Section Content Assessment ───────────────────────────────────

export interface SectionContentAssessment {
  /** Raw text read from disk. null = file missing. "" = empty file. */
  rawText: string | null;
  /** Whether the content parsed successfully through markdownToJSON */
  parseable: boolean;
  /** If parsing threw, the error (for logging) */
  parseError?: Error;
  /** Which layer this assessment is for */
  source: string;
}

/**
 * Assess a section content file. Reads it, attempts to parse through markdownToJSON.
 * Never throws.
 */
export async function assessSectionContent(
  filePath: string,
  source: string,
): Promise<SectionContentAssessment> {
  let rawText: string | null;
  try {
    rawText = await readFile(filePath, "utf8");
  } catch { // Intentional: tolerant assessment contract — never throws
    return { rawText: null, parseable: false, source };
  }

  if (rawText === "") {
    return { rawText: "", parseable: false, source };
  }

  try {
    // Lazy import to avoid loading the full serializer at module init
    const { markdownToJSON } = await import("@ks/milkdown-serializer");
    markdownToJSON(rawText);
    return { rawText, parseable: true, source };
  } catch (err) {
    return {
      rawText,
      parseable: false,
      parseError: err instanceof Error ? err : new Error(String(err)),
      source,
    };
  }
}
