/**
 * Session Store — Single owner of ALL session file operations.
 *
 * Session files live under sessions/docs/content/ (mirroring canonical
 * content/ structure) and sessions/authors/ (per-user attribution).
 *
 * Lifecycle:
 *   importSessionDirtyFragmentsToOverlay() — Y.Doc → reconcile markdown → write to sessions/docs/
 *   readSectionWithOverlay()         — read a section, preferring session overlay over canonical
 *   commitSessionFilesToCanonical()  — read from sessions/docs/, commit to canonical via git
 *   cleanupSessionFiles()            — delete session files after commit or on crash recovery
 */

import path from "node:path";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { getContentRoot, getDataRoot, getSessionDocsContentRoot, getSessionAuthorsRoot, getSessionFragmentsRoot } from "./data-root.js";

import { ContentLayer, OverlayContentLayer, DocumentNotFoundError } from "./content-layer.js";
import { CanonicalStore } from "./canonical-store.js";
import { parseSkeletonToEntries } from "./document-skeleton.js";
import type { WriterIdentity } from "../types/shared.js";
import type { DocSession } from "../crdt/ydoc-lifecycle.js";
import type { ImportDirtyFragmentsToSessionOverlayResult } from "../crdt/document-fragments.js";
import type { FragmentContent, SectionBody } from "./section-formatting.js";

// ─── Helpers ─────────────────────────────────────────────────────

export { getSessionDocsContentRoot } from "./data-root.js";

// ─── Raw fragment file I/O (sessions/fragments/) ─────────────────

/**
 * Get the directory for raw fragment files for a given document.
 * Creates the directory if it doesn't exist.
 */
function getFragmentDir(docPath: string): string {
  return path.join(getSessionFragmentsRoot(), docPath);
}

/**
 * Write a raw fragment file to sessions/fragments/{docPath}/{fragmentFile}.
 * Content is verbatim markdown from Y.XmlFragment (heading + body).
 */
export async function writeRawFragment(
  docPath: string,
  fragmentFile: string,
  content: FragmentContent | string,
): Promise<void> {
  const dir = getFragmentDir(docPath);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fragmentFile), content, "utf8");
}

/**
 * Read a raw fragment file from sessions/fragments/{docPath}/{fragmentFile}.
 * Returns null if the file doesn't exist.
 */
export async function readRawFragment(
  docPath: string,
  fragmentFile: string,
): Promise<string | null> {
  try {
    return await readFile(path.join(getFragmentDir(docPath), fragmentFile), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Delete a raw fragment file from sessions/fragments/{docPath}/{fragmentFile}.
 */
export async function deleteRawFragment(
  docPath: string,
  fragmentFile: string,
): Promise<void> {
  try {
    await rm(path.join(getFragmentDir(docPath), fragmentFile));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Delete all raw fragment files for a document.
 */
export async function deleteAllRawFragments(docPath: string): Promise<void> {
  const dir = getFragmentDir(docPath);
  try {
    await rm(dir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * List all raw fragment files for a document.
 * Returns an array of filenames (not full paths).
 */
export async function listRawFragments(docPath: string): Promise<string[]> {
  const dir = getFragmentDir(docPath);
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Scan for all document paths that have raw fragment files.
 * Returns an array of docPath strings.
 */
export async function scanSessionFragmentDocPaths(): Promise<string[]> {
  const root = getSessionFragmentsRoot();
  const result: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    // Check if this directory contains .md files (it's a fragment dir)
    const hasMdFiles = entries.some((e) => e.isFile() && e.name.endsWith(".md"));
    if (hasMdFiles) {
      result.push(prefix);
    }

    // Recurse into subdirectories (for nested doc paths like "docs/guide.md")
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }

  await walk(root, "");
  return result;
}

// ─── importSessionDirtyFragmentsToOverlay ────────────────────────

/**
 * Import dirty fragments from a Y.Doc session into the session overlay on disk.
 *
 * Thin wrapper around DocumentFragments.importDirtyFragmentsToSessionOverlay()
 * that handles session-level
 * concerns (dirty tracking cleanup, author metadata).
 */
export { type ImportDirtyFragmentsToSessionOverlayResult } from "../crdt/document-fragments.js";

export async function importSessionDirtyFragmentsToOverlay(
  session: DocSession,
  opts?: {
    fragmentKeys?: Set<string>;
  },
): Promise<ImportDirtyFragmentsToSessionOverlayResult> {
  if (session.fragments.dirtyKeys.size === 0) {
    return { writtenKeys: [], deletedKeys: [] };
  }

  const result = await session.fragments.importDirtyFragmentsToSessionOverlay({
    fragmentKeys: opts?.fragmentKeys,
  });

  // Update author metadata files
  const authorsRoot = getSessionAuthorsRoot();
  for (const [writerId, dirtyFragments] of session.perUserDirty) {
    if (dirtyFragments.size === 0) continue;

    const authorFile = path.join(authorsRoot, `${writerId}.json`);
    const dirtySections = [...dirtyFragments].map((fk) => {
      const headingPath = session.fragments.findHeadingPathForFragmentKey(fk) ?? [];
      return {
        docPath: session.docPath,
        headingPath,
        firstChangedAt: session.fragmentFirstActivity.get(fk) ?? session.createdAt,
      };
    });

    await mkdir(path.dirname(authorFile), { recursive: true });
    await writeFile(
      authorFile,
      JSON.stringify({ writerId, dirtySections }, null, 2),
      "utf8",
    );
  }

  return result;
}

// ─── readSectionWithOverlay ──────────────────────────────────────

/**
 * Read a section, checking the session overlay (sessions/docs/content/) first.
 * If the section file exists in the session overlay, return that content
 * (it represents unflushed/uncommitted edits). Otherwise fall back to canonical.
 *
 * Delegates to OverlayContentLayer for overlay-first body reads.
 */
export async function readSectionWithOverlay(
  docPath: string,
  headingPath: string[],
): Promise<string> {
  const overlay = new OverlayContentLayer(getSessionDocsContentRoot(), getContentRoot());
  const { SectionRef } = await import("../domain/section-ref.js");
  return overlay.readSection(new SectionRef(docPath, headingPath));
}

// ─── Bulk section content reader ─────────────────────────────────

/**
 * Read ALL section contents for a document in bulk, preferring session
 * overlay over canonical. Delegates to OverlayContentLayer.readAllSections().
 *
 * @returns Map keyed by headingPath.join(">>") → content string
 */
export async function readAllSectionsWithOverlay(
  docPath: string,
): Promise<Map<string, SectionBody>> {
  const overlay = new OverlayContentLayer(getSessionDocsContentRoot(), getContentRoot());
  return overlay.readAllSections(docPath);
}

// ─── commitSessionFilesToCanonical ───────────────────────────────

/**
 * Read dirty section files from sessions/docs/content/, promote overlay
 * skeletons to canonical (handling heading renames), and commit to
 * canonical via the commit pipeline.
 *
 * Uses DocumentSkeleton.forEachSection to iterate sections — this correctly handles
 * sub-skeletons, root children, and arbitrarily nested structures.
 *
 * Used by:
 * - crash-recovery (on startup) to salvage unflushed edits
 * - disconnect commit (when last holder disconnects or idle timeout fires)
 * - manual publish (human clicks "Publish Now")
 * - shutdown commit (server graceful shutdown)
 *
 * @param writer - Identity to attribute the commit to
 * @param docPath - Optional: limit to a specific document
 * @returns Number of sections committed
 */
export interface CommitSessionResult {
  sectionsCommitted: number;
  commitSha?: string;
  committedSections: Array<{ doc_path: string; heading_path: string[] }>;
  /** Documents whose overlay skeleton was corrupt — commit skipped for these. */
  skeletonErrors: Array<{ docPath: string; error: string }>;
}

export async function commitSessionFilesToCanonical(
  contributors: WriterIdentity[],
  docPath?: string,
): Promise<CommitSessionResult> {
  const contentRoot = getContentRoot();
  const sessionDocsContentRoot = getSessionDocsContentRoot();

  // Determine which documents to process
  const docPaths = docPath ? [docPath] : await scanSessionDocPaths();

  // Pre-validate overlay skeletons (per-doc error isolation: corrupt overlay for
  // one doc must not block others). The validated path list also drives the
  // before/after canonical-content snapshots used to compute the actual changed
  // section set below.
  const validDocPaths: string[] = [];
  const skeletonErrors: Array<{ docPath: string; error: string }> = [];
  let totalProcessedSections = 0;

  for (const dp of docPaths) {
    const overlayLayer = new OverlayContentLayer(sessionDocsContentRoot, contentRoot);
    try {
      const headingPaths = await overlayLayer.listHeadingPaths(dp);
      await validateOverlayStagingDocIntegrity(dp, sessionDocsContentRoot);
      validDocPaths.push(dp);
      totalProcessedSections += headingPaths.length;
    } catch (err) {
      skeletonErrors.push({
        docPath: dp,
        error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.trim() : String(err),
      });
      continue;
    }
  }

  if (validDocPaths.length === 0) {
    return { sectionsCommitted: 0, committedSections: [], skeletonErrors };
  }

  // Capture canonical content per validDocPath BEFORE absorb so we can compute
  // the actual changed-section set after absorb. Documents that do not yet
  // exist in canonical (new docs) are represented as an empty map; every
  // section in the after-snapshot will then be reported as new/changed.
  const canonicalLayer = new ContentLayer(contentRoot);
  const beforeContent = new Map<string, Map<string, SectionBody>>();
  for (const dp of validDocPaths) {
    try {
      beforeContent.set(dp, await canonicalLayer.readAllSections(dp));
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        beforeContent.set(dp, new Map());
        continue;
      }
      throw err;
    }
  }

  const [primaryWriter, ...coWriters] = contributors;
  let commitMessage = `human edit: ${primaryWriter.displayName}\n\nWriter: ${primaryWriter.id}\nWriter-Type: ${primaryWriter.type}`;
  if (coWriters.length > 0) {
    commitMessage += "\n" + coWriters
      .map((w) => `Co-authored-by: ${w.displayName} <${w.email ?? `${w.id}@knowledge-store.local`}>`)
      .join("\n");
  }
  const author = { name: primaryWriter.displayName, email: primaryWriter.email ?? "human@knowledge-store.local" };

  const store = new CanonicalStore(contentRoot, getDataRoot());
  // When committing a single doc, filter to only that doc's files so other writers'
  // pending session edits are not absorbed. absorb() handles filtering internally.
  const absorbOpts = docPath ? { docPaths: validDocPaths } : undefined;
  const commitSha = await store.absorb(sessionDocsContentRoot, commitMessage, author, absorbOpts);

  // Diff canonical-after vs canonical-before to derive the actual changed
  // heading-path set. Anything in only one snapshot, or whose body changed,
  // is reported as a committed section. Sections present unchanged in both
  // snapshots are intentionally NOT reported (Bug C: previously every
  // skeleton path was reported regardless of whether it was touched).
  const committedSections: Array<{ doc_path: string; heading_path: string[] }> = [];
  for (const dp of validDocPaths) {
    let afterSections: Map<string, SectionBody>;
    try {
      afterSections = await canonicalLayer.readAllSections(dp);
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        afterSections = new Map();
      } else {
        throw err;
      }
    }
    const beforeSections = beforeContent.get(dp)!;
    const allKeys = new Set<string>([...beforeSections.keys(), ...afterSections.keys()]);
    for (const key of allKeys) {
      const before = beforeSections.get(key) ?? null;
      const after = afterSections.get(key) ?? null;
      if (before === after) continue;
      const headingPath = key === "" ? [] : key.split(">>");
      committedSections.push({ doc_path: dp, heading_path: headingPath });
    }
  }

  return { sectionsCommitted: totalProcessedSections, commitSha, committedSections, skeletonErrors };
}

function normalizeDocPathForDisk(docPath: string): string {
  return docPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function collectExpectedSectionFilesFromSkeleton(
  skeletonPath: string,
  relPrefix = "",
): Promise<Set<string>> {
  let content: string;
  try {
    content = await readFile(skeletonPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
    throw err;
  }

  const expected = new Set<string>();
  const entries = parseSkeletonToEntries(content);
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.sectionFile}` : entry.sectionFile;
    expected.add(rel);
    const childSkeletonPath = path.join(`${skeletonPath}.sections`, entry.sectionFile);
    const childPrefix = `${rel}.sections`;
    const childExpected = await collectExpectedSectionFilesFromSkeleton(childSkeletonPath, childPrefix);
    for (const p of childExpected) expected.add(p);
  }
  return expected;
}

async function listRelativeFilesRecursive(dir: string, relPrefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const out: string[] = [];
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listRelativeFilesRecursive(full, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

async function validateOverlayStagingDocIntegrity(
  docPath: string,
  sessionDocsContentRoot: string,
): Promise<void> {
  const normalized = normalizeDocPathForDisk(docPath);
  const overlaySkeletonPath = path.resolve(sessionDocsContentRoot, ...normalized.split("/"));

  // Overlay invariant: section/body files in sessions/docs/content must never
  // exist without an overlay skeleton for the same doc path.
  try {
    await readFile(overlaySkeletonPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const danglingFiles = await listRelativeFilesRecursive(`${overlaySkeletonPath}.sections`);
      if (danglingFiles.length > 0) {
        const sample = danglingFiles.slice(0, 5).join(", ");
        const suffix = danglingFiles.length > 5 ? ` (+${danglingFiles.length - 5} more)` : "";
        throw new Error(
          `Staging overlay integrity failure in "${docPath}": ` +
          `${danglingFiles.length} file(s) exist under "${normalized}.sections" ` +
          `but no overlay skeleton exists at "${normalized}" (${sample}${suffix}).`,
        );
      }
      return;
    }
    throw err;
  }

  const expectedFiles = await collectExpectedSectionFilesFromSkeleton(overlaySkeletonPath);
  const actualFiles = await listRelativeFilesRecursive(`${overlaySkeletonPath}.sections`);
  const unreferenced = actualFiles.filter((rel) => !expectedFiles.has(rel));
  if (unreferenced.length > 0) {
    const sample = unreferenced.slice(0, 5).join(", ");
    const suffix = unreferenced.length > 5 ? ` (+${unreferenced.length - 5} more)` : "";
    throw new Error(
      `Staging skeleton/content mismatch in "${docPath}": ` +
      `${unreferenced.length} unreferenced file(s) present under "${normalized}.sections" ` +
      `that are not declared in the staging skeleton (${sample}${suffix}).`,
    );
  }
}


// ─── scanSessionDocPaths ─────────────────────────────────────────

/**
 * Scan sessions/docs/content/ to discover which documents have session
 * overlay files on disk. Returns doc paths (e.g. "docs/guide.md").
 *
 * Detects documents both by overlay skeleton files (.md) and by
 * .sections/ directories (which exist even when only body content changed
 * without a skeleton change).
 */
export async function scanSessionDocPaths(): Promise<string[]> {
  const sessionDocsContentRoot = getSessionDocsContentRoot();
  const docPaths: string[] = [];
  await walkForDocPaths(sessionDocsContentRoot, "", docPaths);
  return docPaths;
}

async function walkForDocPaths(
  dir: string,
  relativePath: string,
  result: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (entry.name.endsWith(".sections")) {
        // A .sections/ directory implies a document skeleton at the parent level
        const docPath = relPath.replace(/\.sections$/, "");
        if (!result.includes(docPath)) {
          result.push(docPath);
        }
      } else {
        await walkForDocPaths(fullPath, relPath, result);
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      // Skeleton file — this is a document
      if (!result.includes(relPath)) {
        result.push(relPath);
      }
    }
  }
}

// ─── cleanupSessionFiles ─────────────────────────────────────────

/**
 * Delete session files after they've been committed to canonical.
 * Removes session content files, raw fragments, and author metadata.
 *
 * @param docPath - Optional: limit cleanup to a specific document's files.
 *                  If omitted, cleans up ALL session files (used on crash recovery).
 */
export async function cleanupSessionFiles(docPath?: string): Promise<void> {
  const sessionDocsContentRoot = getSessionDocsContentRoot();
  const sessionAuthorsRoot = getSessionAuthorsRoot();
  const sessionFragmentsRoot = getSessionFragmentsRoot();

  if (docPath) {
    // Clean up session files for a specific document
    const normalized = docPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const skeletonPath = path.resolve(sessionDocsContentRoot, ...normalized.split("/"));
    const sectionsDir = `${skeletonPath}.sections`;

    await rm(skeletonPath, { force: true });
    await rm(sectionsDir, { recursive: true, force: true });

    // Clean up raw fragment files for this document
    const fragmentDocDir = path.resolve(sessionFragmentsRoot, ...normalized.split("/"));
    await rm(fragmentDocDir, { recursive: true, force: true });

    // Clean up author metadata: remove entries for this docPath from each author file
    try {
      const authorFiles = await readdir(sessionAuthorsRoot);
      for (const fileName of authorFiles) {
        if (!fileName.endsWith(".json")) continue;
        const authorFilePath = path.join(sessionAuthorsRoot, fileName);
        try {
          const raw = await readFile(authorFilePath, "utf8");
          const data = JSON.parse(raw) as { writerId: string; dirtySections: Array<{ docPath: string }> };
          const remaining = data.dirtySections.filter((s) => s.docPath !== docPath);
          if (remaining.length === 0) {
            await rm(authorFilePath, { force: true });
          } else if (remaining.length < data.dirtySections.length) {
            await writeFile(authorFilePath, JSON.stringify({ ...data, dirtySections: remaining }, null, 2), "utf8");
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  } else {
    // Clean up all session files (docs, fragments, authors)
    await rm(sessionDocsContentRoot, { recursive: true, force: true });
    await rm(sessionFragmentsRoot, { recursive: true, force: true });
    await rm(sessionAuthorsRoot, { recursive: true, force: true });
  }
}
