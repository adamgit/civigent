/**
 * Session state inspector — builds a diagnostic snapshot of all session data.
 *
 * Extracted from the GET /admin/session-state route handler.
 * Pure data logic, no HTTP dependencies.
 */

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { getContentRoot, getSessionSectionsContentRoot, getSessionAuthorsRoot } from "./data-root.js";
import { RawFragmentRecoveryBuffer } from "./raw-fragment-recovery-buffer.js";
import { sectionFileFromFragmentKey } from "../crdt/ydoc-fragments.js";
import { scanSessionFragmentDocPaths, scanSessionDocPaths } from "./session-scan.js";
import { DocumentSkeleton } from "./document-skeleton.js";
import { OverlayContentLayer, SectionNotFoundError } from "./content-layer.js";

// ─── Types ───────────────────────────────────────────────

export interface FragmentFileInfo {
  filename: string;
  sizeBytes: number;
  content: string;
  hasEmbeddedHeading: boolean;
  sectionHeading: string | null;
}

export interface DocOverlayInfo {
  skeleton: { filename: string; content: string; sectionRefs: string[] } | null;
  sections: Array<{ filename: string; content: string; isOrphaned: boolean }>;
  health: "ok" | "corrupt_missing_overlay_skeleton" | "corrupt_skeleton";
  issues: string[];
}

export interface AuthorInfo {
  filename: string;
  dirtySections: Array<{ docPath: string; headingPath: string[]; firstChangedAt: string }>;
}

export interface SessionState {
  fragments: Record<string, FragmentFileInfo[]>;
  docs: Record<string, DocOverlayInfo>;
  authors: Record<string, AuthorInfo>;
  summary: {
    totalFragmentFiles: number;
    totalOverlayDocs: number;
    totalOverlaySections: number;
    totalAuthors: number;
    orphanedSections: number;
    corruptOverlayDocs: number;
    missingOverlaySkeletonDocs: number;
  };
}

function isSkeletonParseOrIntegrityError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("Skeleton integrity error") || err.message.includes("Skeleton parse error");
}

// ─── Implementation ──────────────────────────────────────

export async function getSessionState(): Promise<SessionState> {
  // ── Fragments ──
  const fragmentDocPaths = await scanSessionFragmentDocPaths();
  const fragments: Record<string, FragmentFileInfo[]> = {};
  let totalFragmentFiles = 0;
  for (const docPath of fragmentDocPaths) {
    const buffer = new RawFragmentRecoveryBuffer(docPath);
    const fragmentKeys = await buffer.listFragmentKeys();
    const overlayLayer = new OverlayContentLayer(getSessionSectionsContentRoot(), getContentRoot());
    const entries: FragmentFileInfo[] = [];
    for (const fragmentKey of fragmentKeys) {
      const content = await buffer.readFragment(fragmentKey);
      if (content === null) continue;
      const sizeBytes = Buffer.byteLength(content, "utf8");
      let sectionHeading: string | null = null;
      const fileId = sectionFileFromFragmentKey(fragmentKey);
      try {
        const entry = await overlayLayer.resolveSectionFileId(docPath, fileId);
        sectionHeading = entry.heading || "(before first heading)";
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (err instanceof SectionNotFoundError || code === "ENOENT") {
          // Missing skeleton/section mapping is expected in this diagnostic view.
        } else {
          throw err;
        }
      }
      const filename = `${fileId}.md`;
      entries.push({
        filename,
        sizeBytes,
        content,
        hasEmbeddedHeading: content.trimStart().startsWith("#"),
        sectionHeading,
      });
      totalFragmentFiles++;
    }
    fragments[docPath] = entries;
  }

  // ── Docs overlay ──
  const docs: Record<string, DocOverlayInfo> = {};
  let totalOverlayDocs = 0;
  let totalOverlaySections = 0;
  let orphanedSections = 0;
  let corruptOverlayDocs = 0;
  let missingOverlaySkeletonDocs = 0;
  const contentSubdir = getSessionSectionsContentRoot();
  let overlayDocPaths: string[] = [];
  try {
    overlayDocPaths = await scanSessionDocPaths();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const docPath of overlayDocPaths) {
    const overlaySkeletonPath = path.join(contentSubdir, docPath);
    const sectionsDir = `${overlaySkeletonPath}.sections`;
    let skeletonContent: string | null = null;
    const issues: string[] = [];

    try {
      skeletonContent = await readFile(overlaySkeletonPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const sectionRefSet = new Set<string>();
    if (skeletonContent !== null) {
      try {
        const overlayOnlySkeleton = await DocumentSkeleton.fromDisk(
          docPath,
          contentSubdir,
          contentSubdir,
        );
        for (const entry of overlayOnlySkeleton.allStructuralEntries()) {
          const relative = toPosix(path.relative(sectionsDir, entry.absolutePath));
          if (!relative.startsWith("../")) {
            sectionRefSet.add(relative);
          }
        }
      } catch (err) {
        if (isSkeletonParseOrIntegrityError(err)) {
          issues.push((err as Error).message);
        } else {
          throw err;
        }
      }
    }

    const sectionFiles: Array<{ filename: string; content: string; isOrphaned: boolean }> = [];
    const rawSectionFiles = await readSectionFilesRecursive(sectionsDir);
    for (const sf of rawSectionFiles) {
      const isOrphaned = !sectionRefSet.has(sf.filename);
      sectionFiles.push({ filename: sf.filename, content: sf.content, isOrphaned });
      totalOverlaySections++;
      if (isOrphaned) orphanedSections++;
    }

    let health: DocOverlayInfo["health"] = "ok";
    if (skeletonContent === null && rawSectionFiles.length > 0) {
      health = "corrupt_missing_overlay_skeleton";
      missingOverlaySkeletonDocs++;
      issues.push(
        `Found ${rawSectionFiles.length} file(s) under "${docPath}.sections" but no overlay skeleton "${docPath}".`,
      );
    } else if (issues.length > 0) {
      health = "corrupt_skeleton";
    }
    if (health !== "ok") {
      corruptOverlayDocs++;
    }

    docs[docPath] = {
      skeleton: skeletonContent === null
        ? null
        : { filename: path.basename(overlaySkeletonPath), content: skeletonContent, sectionRefs: [...sectionRefSet] },
      sections: sectionFiles,
      health,
      issues,
    };
    totalOverlayDocs++;
  }

  // ── Authors ──
  const authorsRoot = getSessionAuthorsRoot();
  const authors: Record<string, AuthorInfo> = {};
  let totalAuthors = 0;
  try {
    const authorFiles = await readdir(authorsRoot);
    for (const af of authorFiles) {
      if (!af.endsWith(".json")) continue;
      const raw = await readFile(path.join(authorsRoot, af), "utf8");
      const parsed = JSON.parse(raw);
      const dirtySections: Array<{ docPath: string; headingPath: string[]; firstChangedAt: string }> = [];
      if (Array.isArray(parsed.dirtySections)) {
        for (const ds of parsed.dirtySections) {
          dirtySections.push({
            docPath: ds.docPath ?? "",
            headingPath: Array.isArray(ds.headingPath) ? ds.headingPath : [],
            firstChangedAt: ds.firstChangedAt ?? "",
          });
        }
      }
      const writerId = af.replace(/\.json$/, "");
      authors[writerId] = { filename: af, dirtySections };
      totalAuthors++;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return {
    fragments,
    docs,
    authors,
    summary: {
      totalFragmentFiles,
      totalOverlayDocs,
      totalOverlaySections,
      totalAuthors,
      orphanedSections,
      corruptOverlayDocs,
      missingOverlaySkeletonDocs,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

async function readSectionFilesRecursive(
  sectionsDir: string,
  prefix = "",
): Promise<Array<{ filename: string; content: string }>> {
  let entries;
  try {
    entries = await readdir(sectionsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const out: Array<{ filename: string; content: string }> = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(sectionsDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await readSectionFilesRecursive(fullPath, rel));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    out.push({
      filename: toPosix(rel),
      content: await readFile(fullPath, "utf8"),
    });
  }
  return out;
}
