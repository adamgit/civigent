/**
 * RecoveryLayers — Tolerant readers for crash recovery.
 *
 * Normal-operation abstractions throw on corruption. During crash recovery,
 * corruption is the expected state. Everything in this module never throws
 * on corrupt/missing/truncated data. Every readable byte is preserved.
 *
 * See: TRANSIENT WORKING DOCS/crash-recovery-correct-algorithm.md
 */

import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  parseSkeletonToEntries,
  serializeSkeletonEntries,
  DocumentSkeleton,
  DocumentSkeletonInternal,
  generateSectionFilename,
  sectionFileToName,
  type SkeletonEntry,
  type SkeletonNode,
} from "./document-skeleton.js";
import { getContentRoot, getSessionSectionsContentRoot, getSessionFragmentsRoot } from "./data-root.js";
import { bodyFromRecoveryAssembly, bodyToDisk } from "./section-formatting.js";

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
  } catch { // Intentional: recovery module contract — never throws (see module header)
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
  } catch { // Intentional: recovery module contract — never throws (see module header)
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

// ─── Compound Skeleton Construction ───────────────────────────────

export interface CompoundSkeletonResult {
  skeleton: DocumentSkeleton;
  appendixSections: Array<{ sectionFile: string; recoveredSectionFile: string; source: string }>;
  overlayAssessment: SkeletonAssessment;
  canonicalAssessment: SkeletonAssessment;
}

/**
 * Resolve skeleton and sections paths for a docPath within a given root.
 */
function resolveDocPaths(docPath: string, root: string): { skeletonPath: string; sectionsDir: string } {
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const skeletonPath = path.resolve(root, ...normalized.split("/"));
  const sectionsDir = `${skeletonPath}.sections`;
  return { skeletonPath, sectionsDir };
}

/**
 * Build entries into a flat SkeletonNode[] (no nesting — recovery doesn't reconstruct
 * the heading tree, it preserves all sections in document order).
 */
function entriesToNodes(entries: SkeletonEntry[]): SkeletonNode[] {
  return entries.map((e) => ({
    heading: e.heading,
    level: e.level,
    sectionFile: e.sectionFile,
    children: [],
  }));
}

function mintRecoveredSectionFile(name: string, usedSectionFiles: Set<string>): string {
  let candidate = "";
  do {
    candidate = generateSectionFilename(`Recovered ${name}`);
  } while (usedSectionFiles.has(candidate));
  usedSectionFiles.add(candidate);
  return candidate;
}

/**
 * Build a compound skeleton from overlay + canonical layers + raw fragment scan.
 * Never throws. Produces the most complete skeleton possible from whatever is on disk.
 */
export async function buildCompoundSkeleton(docPath: string): Promise<CompoundSkeletonResult> {
  const contentRoot = getContentRoot();
  const overlayContentRoot = getSessionSectionsContentRoot();
  const fragmentsRoot = getSessionFragmentsRoot();

  const overlayPaths = resolveDocPaths(docPath, overlayContentRoot);
  const canonicalPaths = resolveDocPaths(docPath, contentRoot);

  const [overlayAssessment, canonicalAssessment] = await Promise.all([
    assessSkeleton(overlayPaths.skeletonPath, overlayPaths.sectionsDir),
    assessSkeleton(canonicalPaths.skeletonPath, canonicalPaths.sectionsDir),
  ]);

  // Choose the base skeleton: whichever covers more files on disk.
  // Overlay is preferred when tie (more recent edits).
  const overlayCovers = overlayAssessment.entries.length;
  const canonicalCovers = canonicalAssessment.entries.length;
  const useOverlayAsBase = overlayCovers >= canonicalCovers && overlayCovers > 0;

  const base = useOverlayAsBase ? overlayAssessment : canonicalAssessment;
  const other = useOverlayAsBase ? canonicalAssessment : overlayAssessment;

  // Start with base entries
  const mergedSectionFiles = new Set(base.entries.map((e) => e.sectionFile));
  let mergedEntries: SkeletonEntry[] = [...base.entries];

  // Merge entries from the other layer that reference files existing on disk but absent from base
  const allFilesOnDisk = new Set([
    ...overlayAssessment.filesOnDisk,
    ...canonicalAssessment.filesOnDisk,
  ]);

  for (const entry of other.entries) {
    if (!mergedSectionFiles.has(entry.sectionFile) && allFilesOnDisk.has(entry.sectionFile)) {
      mergedEntries.push(entry);
      mergedSectionFiles.add(entry.sectionFile);
    }
  }

  // Discover orphan files: on disk in either layer but not in any skeleton entry
  const appendixSections: Array<{ sectionFile: string; recoveredSectionFile: string; source: string }> = [];

  for (const file of overlayAssessment.filesOnDisk) {
    if (!mergedSectionFiles.has(file)) {
      appendixSections.push({ sectionFile: file, recoveredSectionFile: "", source: "overlay" });
      mergedSectionFiles.add(file);
    }
  }
  for (const file of canonicalAssessment.filesOnDisk) {
    if (!mergedSectionFiles.has(file)) {
      appendixSections.push({ sectionFile: file, recoveredSectionFile: "", source: "canonical" });
      mergedSectionFiles.add(file);
    }
  }

  // Scan raw fragments directory for files not covered by either skeleton
  const fragmentDir = path.resolve(fragmentsRoot, ...docPath.replace(/\\/g, "/").replace(/^\/+/, "").split("/"));
  let fragmentFiles: string[] = [];
  try {
    const entries = await readdir(fragmentDir);
    fragmentFiles = entries.filter((f) => f.endsWith(".md"));
  } catch { // Intentional: recovery module contract — never throws (see module header)
    // No fragment directory
  }

  for (const file of fragmentFiles) {
    if (!mergedSectionFiles.has(file)) {
      appendixSections.push({ sectionFile: file, recoveredSectionFile: "", source: "fragment" });
      mergedSectionFiles.add(file);
    }
  }

  // Add appendix sections as flat entries (level 2, generic heading)
  for (const orphan of appendixSections) {
    const name = sectionFileToName(orphan.sectionFile);
    const recoveredSectionFile = mintRecoveredSectionFile(name, mergedSectionFiles);
    orphan.recoveredSectionFile = recoveredSectionFile;
    mergedEntries.push({
      heading: `Recovered: ${name}`,
      level: 2,
      sectionFile: recoveredSectionFile,
    });
  }

  // Deduplicate before-first-heading entries (level=0, heading=""). Only the first is kept;
  // subsequent duplicates are demoted to appendix sections so their content is still recovered.
  let seenBfh = false;
  const deduped: SkeletonEntry[] = [];
  for (const entry of mergedEntries) {
    if (entry.level === 0 && entry.heading === "") {
      if (!seenBfh) {
        deduped.push(entry);
        seenBfh = true;
      } else {
        const name = sectionFileToName(entry.sectionFile);
        const recoveredSectionFile = mintRecoveredSectionFile(name, mergedSectionFiles);
        deduped.push({
          heading: `Recovered: ${name}`,
          level: 2,
          sectionFile: recoveredSectionFile,
        });
        appendixSections.push({
          sectionFile: entry.sectionFile,
          recoveredSectionFile,
          source: "dedup",
        });
      }
    } else {
      deduped.push(entry);
    }
  }
  mergedEntries = deduped;

  // mergedEntries may be empty — this is valid for live-empty documents.
  // entriesToNodes([]) returns [] and fromNodes(docPath, [], root) creates a valid empty skeleton.
  const nodes = entriesToNodes(mergedEntries);
  const skeleton = DocumentSkeletonInternal.fromNodes(docPath, nodes, contentRoot);

  return {
    skeleton,
    appendixSections,
    overlayAssessment,
    canonicalAssessment,
  };
}

// ─── Per-Section Recovery ─────────────────────────────────────────

export interface SectionDiagnostic {
  sectionFile: string;
  source: "fragment" | "overlay" | "canonical" | "placeholder";
  parseFailure: boolean;
  falseResurrection: boolean;
  orphan: boolean;
}

export interface DocumentRecoveryResult {
  sections: Array<{ doc_path: string; heading_path: string[]; content: string }>;
  sectionDiagnostics: SectionDiagnostic[];
  appendixSections: string[];
  consumedSessionFiles: Set<string>;
}

/**
 * Wrap raw unparseable content in a fenced code block with a recovery notice.
 */
function wrapParseFailure(rawText: string): string {
  // Use a fence that won't collide with content
  const fence = rawText.includes("```") ? "````" : "```";
  return (
    `> **Crash recovery notice:** This section's content could not be parsed\n` +
    `> automatically. The raw text is preserved below for manual review.\n` +
    `> Edit this section to extract the content you need, then remove this notice.\n\n` +
    `${fence}\n${rawText}\n${fence}`
  );
}

/**
 * Wrap orphan/appendix content with a position-unknown notice.
 */
function wrapAppendix(content: string): string {
  return (
    `> **Crash recovery notice:** This content was found in session files but its\n` +
    `> position in the document could not be determined. Review it, move useful\n` +
    `> content to the correct section, then delete this section.\n\n` +
    content
  );
}

/**
 * Apply the per-section decision table from crash-recovery-correct-algorithm.md.
 *
 * Freshness hierarchy: fragment > overlay > canonical.
 * Empty higher layer = treat as crash damage (false resurrection).
 * Non-empty but unparseable = preserve raw text in fenced code block.
 */
function decideContent(
  fragment: SectionContentAssessment | null,
  overlay: SectionContentAssessment | null,
  canonical: SectionContentAssessment | null,
  sectionFile: string,
): { content: string; diagnostic: SectionDiagnostic } {
  // Helper: pick the first assessment with non-empty, parseable content
  const layers: Array<{ assessment: SectionContentAssessment | null; source: "fragment" | "overlay" | "canonical" }> = [
    { assessment: fragment, source: "fragment" },
    { assessment: overlay, source: "overlay" },
    { assessment: canonical, source: "canonical" },
  ];

  for (const { assessment, source } of layers) {
    if (!assessment || assessment.rawText === null) continue;

    if (assessment.rawText === "") {
      // Empty file — treat as crash damage, fall through to lower layer
      continue;
    }

    // Non-empty content
    if (assessment.parseable) {
      // Determine if this is a false resurrection (higher layer was empty)
      const higherLayerWasEmpty = layers
        .slice(0, layers.findIndex(l => l.source === source))
        .some(l => l.assessment?.rawText === "");

      return {
        content: assessment.rawText,
        diagnostic: {
          sectionFile,
          source,
          parseFailure: false,
          falseResurrection: higherLayerWasEmpty,
          orphan: false,
        },
      };
    }

    // Non-empty but unparseable — preserve raw text
    const higherLayerWasEmpty = layers
      .slice(0, layers.findIndex(l => l.source === source))
      .some(l => l.assessment?.rawText === "");

    return {
      content: wrapParseFailure(assessment.rawText),
      diagnostic: {
        sectionFile,
        source,
        parseFailure: true,
        falseResurrection: higherLayerWasEmpty,
        orphan: false,
      },
    };
  }

  // All layers empty or missing — placeholder
  const allEmpty = layers.some(l => l.assessment?.rawText === "");
  return {
    content: allEmpty
      ? "> *This section was empty in all layers during crash recovery.*"
      : "> *Content missing — may have been lost during crash.*",
    diagnostic: {
      sectionFile,
      source: "placeholder",
      parseFailure: false,
      falseResurrection: false,
      orphan: false,
    },
  };
}

/**
 * Recover a single document's content using the per-section decision table.
 * Never throws. Produces the best possible result from whatever is on disk.
 */
export async function recoverDocument(docPath: string): Promise<DocumentRecoveryResult> {
  const contentRoot = getContentRoot();
  const overlayContentRoot = getSessionSectionsContentRoot();
  const fragmentsRoot = getSessionFragmentsRoot();

  const compound = await buildCompoundSkeleton(docPath);
  const consumedSessionFiles = new Set<string>();

  const sections: DocumentRecoveryResult["sections"] = [];
  const sectionDiagnostics: SectionDiagnostic[] = [];

  // Resolve paths for each layer
  const normalizedDoc = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fragmentDir = path.resolve(fragmentsRoot, ...normalizedDoc.split("/"));
  const overlayPaths = resolveDocPaths(docPath, overlayContentRoot);
  const canonicalPaths = resolveDocPaths(docPath, contentRoot);
  const appendixByRecoveredSectionFile = new Map(
    compound.appendixSections.map((entry) => [entry.recoveredSectionFile, entry]),
  );

  // Track overlay skeleton file as consumed
  try {
    await readFile(path.resolve(overlayContentRoot, ...normalizedDoc.split("/")), "utf8");
    consumedSessionFiles.add(path.resolve(overlayContentRoot, ...normalizedDoc.split("/")));
  } catch { /* missing overlay skeleton is fine */ }

  // Iterate all sections in the compound skeleton
  compound.skeleton.forEachSection((_heading, _level, _sectionFile, headingPath) => {
    // We'll collect the section files to assess — actual assessment happens below
    sections.push({
      doc_path: docPath,
      heading_path: [...headingPath],
      content: "", // placeholder, filled in below
    });
  });

  // Now assess content for each section (can't do async inside forEachSection)
  let idx = 0;
  const sectionEntries: Array<{ headingPath: string[]; sectionFile: string }> = [];
  compound.skeleton.forEachSection((_heading, _level, sectionFile, headingPath) => {
    sectionEntries.push({ headingPath: [...headingPath], sectionFile });
  });

  for (const { headingPath, sectionFile } of sectionEntries) {
    const appendixInfo = appendixByRecoveredSectionFile.get(sectionFile);
    const sourceSectionFile = appendixInfo?.sectionFile ?? sectionFile;
    const fragmentPath = path.join(fragmentDir, sourceSectionFile);
    const overlayPath = path.join(overlayPaths.sectionsDir, sourceSectionFile);
    const canonicalPath = path.join(canonicalPaths.sectionsDir, sourceSectionFile);

    const [fragment, overlay, canonical] = await Promise.all([
      assessSectionContent(fragmentPath, "fragment"),
      assessSectionContent(overlayPath, "overlay"),
      assessSectionContent(canonicalPath, "canonical"),
    ]);

    // Track consumed session files
    if (fragment.rawText !== null) consumedSessionFiles.add(fragmentPath);
    if (overlay.rawText !== null) consumedSessionFiles.add(overlayPath);

    const isOrphan = appendixInfo !== undefined;

    const { content, diagnostic } = decideContent(fragment, overlay, canonical, sourceSectionFile);

    // Wrap appendix sections with position-unknown notice
    const finalContent = isOrphan ? wrapAppendix(content) : content;
    diagnostic.orphan = isOrphan;

    sections[idx] = {
      doc_path: docPath,
      heading_path: headingPath,
      content: finalContent,
    };
    sectionDiagnostics.push(diagnostic);
    idx++;
  }

  return {
    sections,
    sectionDiagnostics,
    appendixSections: compound.appendixSections.map((a) => a.sectionFile),
    consumedSessionFiles,
  };
}

// ─── Cleanup Reconciliation ───────────────────────────────────────

export interface ReconciliationResult {
  safe: boolean;
  missedFiles: string[];
}

/**
 * List all session files on disk for a given document.
 */
async function listAllSessionFiles(docPath: string): Promise<string[]> {
  const overlayContentRoot = getSessionSectionsContentRoot();
  const fragmentsRoot = getSessionFragmentsRoot();
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const files: string[] = [];

  // Overlay skeleton
  const overlaySkeleton = path.resolve(overlayContentRoot, ...normalized.split("/"));
  try {
    await readFile(overlaySkeleton, "utf8");
    files.push(overlaySkeleton);
  } catch { // Intentional: recovery module contract — never throws (see module header)
    /* missing */
  }

  // Overlay sections
  const overlaySectionsDir = `${overlaySkeleton}.sections`;
  try {
    const entries = await readdir(overlaySectionsDir);
    for (const e of entries) files.push(path.join(overlaySectionsDir, e));
  } catch { // Intentional: recovery module contract — never throws (see module header)
    /* missing */
  }

  // Raw fragments
  const fragmentDir = path.resolve(fragmentsRoot, ...normalized.split("/"));
  try {
    const entries = await readdir(fragmentDir);
    for (const e of entries) files.push(path.join(fragmentDir, e));
  } catch { // Intentional: recovery module contract — never throws (see module header)
    /* missing */
  }

  return files;
}

/**
 * Verify every session file for a document was accounted for in the recovery result,
 * then clean up if safe.
 *
 * Returns { safe: true, missedFiles: [] } if cleanup proceeded.
 * Returns { safe: false, missedFiles: [...] } if files were missed — cleanup refused.
 */
export async function reconcileAndCleanup(
  docPath: string,
  consumedSessionFiles: Set<string>,
): Promise<ReconciliationResult> {
  const filesOnDisk = await listAllSessionFiles(docPath);
  const missed = filesOnDisk.filter((f) => !consumedSessionFiles.has(f));

  if (missed.length > 0) {
    return { safe: false, missedFiles: missed };
  }

  // All files accounted for — safe to delete
  const overlayContentRoot = getSessionSectionsContentRoot();
  const fragmentsRoot = getSessionFragmentsRoot();
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");

  const overlaySkeleton = path.resolve(overlayContentRoot, ...normalized.split("/"));
  const overlaySectionsDir = `${overlaySkeleton}.sections`;
  const fragmentDir = path.resolve(fragmentsRoot, ...normalized.split("/"));

  await rm(overlaySkeleton, { force: true });
  await rm(overlaySectionsDir, { recursive: true, force: true });
  await rm(fragmentDir, { recursive: true, force: true });

  return { safe: true, missedFiles: [] };
}

// ─── Write Recovered Content to Canonical ─────────────────────────

/**
 * Write recovered sections directly to canonical (skeleton + body files).
 * Bypasses CanonicalStore — acceptable for crash recovery where git state is already dirty
 * and an external git commit is made after this call completes.
 * Uses the compound skeleton's structure directly.
 */
export async function writeRecoveredToCanonical(
  docPath: string,
  recovery: DocumentRecoveryResult,
  compoundSkeleton: DocumentSkeleton,
): Promise<void> {
  const contentRoot = getContentRoot();
  const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const skeletonPath = path.resolve(contentRoot, ...normalized.split("/"));
  const sectionsDir = `${skeletonPath}.sections`;

  await mkdir(sectionsDir, { recursive: true });

  // Write skeleton file from the compound skeleton's entries
  const entries: SkeletonEntry[] = [];
  compoundSkeleton.forEachNode((heading, level, sectionFile) => {
    entries.push({ heading, level, sectionFile });
  });
  const skeletonContent = serializeSkeletonEntries(entries);
  await writeFile(skeletonPath, skeletonContent, "utf8");

  const persistedSectionFiles: string[] = [];
  compoundSkeleton.forEachSection((_heading, _level, sectionFile) => {
    persistedSectionFiles.push(sectionFile);
  });

  // Write each section's body content
  for (let i = 0; i < recovery.sections.length; i++) {
    const persistedSectionFile = persistedSectionFiles[i];
    if (!persistedSectionFile) continue;
    const bodyPath = path.join(sectionsDir, persistedSectionFile);
    await writeFile(bodyPath, bodyToDisk(bodyFromRecoveryAssembly(recovery.sections[i].content)), "utf8");
  }
}
