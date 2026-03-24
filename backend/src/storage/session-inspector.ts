/**
 * Session state inspector — builds a diagnostic snapshot of all session data.
 *
 * Extracted from the GET /admin/session-state route handler.
 * Pure data logic, no HTTP dependencies.
 */

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { getContentRoot, getSessionDocsContentRoot, getSessionAuthorsRoot } from "./data-root.js";
import { scanSessionFragmentDocPaths, listRawFragments, readRawFragment } from "./session-store.js";
import { DocumentSkeleton, SECTIONS_DIR_SUFFIX } from "./document-skeleton.js";

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
  };
}

// ─── Implementation ──────────────────────────────────────

export async function getSessionState(): Promise<SessionState> {
  // ── Fragments ──
  const fragmentDocPaths = await scanSessionFragmentDocPaths();
  const fragments: Record<string, FragmentFileInfo[]> = {};
  let totalFragmentFiles = 0;
  for (const docPath of fragmentDocPaths) {
    const files = await listRawFragments(docPath);
    let skeleton: DocumentSkeleton | null = null;
    try {
      skeleton = await DocumentSkeleton.fromDisk(
        docPath,
        getSessionDocsContentRoot(),
        getContentRoot(),
      );
    } catch {
      // Skeleton doesn't exist or is corrupt — fragments will show as unresolvable
    }
    const entries: FragmentFileInfo[] = [];
    for (const filename of files) {
      const content = await readRawFragment(docPath, filename);
      if (content === null) continue;
      const sizeBytes = Buffer.byteLength(content, "utf8");
      let sectionHeading: string | null = null;
      if (skeleton) {
        const fileId = filename.replace(/\.md$/, "");
        try {
          const entry = skeleton.resolveByFileId(fileId);
          sectionHeading = entry.heading || "(root)";
        } catch { /* fragment may not match any skeleton entry */ }
      }
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
  const contentSubdir = getSessionDocsContentRoot();
  let overlayDocPaths: string[] = [];
  try {
    overlayDocPaths = await readdirRecursiveFiles(contentSubdir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const relPath of overlayDocPaths) {
    const docPath = relPath;
    const fullPath = path.join(contentSubdir, relPath);
    const fileContent = await readFile(fullPath, "utf8");

    const overlaySkeleton = await DocumentSkeleton.fromDisk(docPath, contentSubdir, getContentRoot());
    const sectionRefSet = new Set<string>();
    overlaySkeleton.forEachSection((_h, _l, sectionFile) => {
      sectionRefSet.add(sectionFile);
    });

    const sectionsDir = DocumentSkeleton.sectionsDir(docPath, contentSubdir);
    const sectionFiles: Array<{ filename: string; content: string; isOrphaned: boolean }> = [];
    try {
      const sectionEntries = await readdir(sectionsDir);
      for (const sf of sectionEntries) {
        if (!sf.endsWith(".md")) continue;
        const sContent = await readFile(path.join(sectionsDir, sf), "utf8");
        const isOrphaned = !sectionRefSet.has(sf);
        sectionFiles.push({ filename: sf, content: sContent, isOrphaned });
        totalOverlaySections++;
        if (isOrphaned) orphanedSections++;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    docs[docPath] = {
      skeleton: { filename: path.basename(fullPath), content: fileContent, sectionRefs: [...sectionRefSet] },
      sections: sectionFiles,
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
  } catch { /* authors dir may not exist */ }

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
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────

async function readdirRecursiveFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.endsWith(SECTIONS_DIR_SUFFIX)) continue;
      results.push(...await readdirRecursiveFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".md")) {
      results.push(rel);
    }
  }
  return results;
}
