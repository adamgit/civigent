/**
 * import-staging.ts — Staging folder infrastructure for imports.
 *
 * All state is on disk — no in-memory map, no metadata files.
 * Each import is a subdirectory under /app/data/import-staging/{uuid}/
 * containing only the user's files. Survives server restarts with no
 * reconstruction needed.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { getDataRoot } from "./data-root.js";
import { parseDocumentMarkdown } from "./markdown-sections.js";
import type { ImportFile } from "./import-service.js";

function getImportStagingRoot(): string {
  return path.join(getDataRoot(), "import-staging");
}

function stagingFolderPath(importId: string): string {
  return path.join(getImportStagingRoot(), importId);
}

// ─── Public types ────────────────────────────────────────

export interface StagingFolderInfo {
  importId: string;
  stagingPath: string;
  createdAt: string;
}

export interface StagingFileInfo {
  relativePath: string;
  isMarkdown: boolean;
  sectionCount: number;
}

// ─── Public API ──────────────────────────────────────────

export async function createStagingFolder(): Promise<{ importId: string; stagingPath: string }> {
  const importId = randomUUID();
  const stagingPath = stagingFolderPath(importId);
  await mkdir(stagingPath, { recursive: true });
  return { importId, stagingPath };
}

export async function listStagingFolders(): Promise<StagingFolderInfo[]> {
  const root = getImportStagingRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const results: StagingFolderInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(root, entry.name);
    const stats = await stat(folderPath);
    results.push({
      importId: entry.name,
      stagingPath: folderPath,
      createdAt: stats.birthtime.toISOString(),
    });
  }
  return results;
}

export async function scanStagingFolder(importId: string): Promise<StagingFileInfo[]> {
  const root = stagingFolderPath(importId);
  const files: StagingFileInfo[] = [];

  const walk = async (relativeDir: string) => {
    const absoluteDir = path.join(root, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(relPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const isMarkdown = relPath.toLowerCase().endsWith(".md");
      let sectionCount = 0;
      if (isMarkdown) {
        try {
          const content = await readFile(path.join(root, relPath), "utf8");
          const parsed = parseDocumentMarkdown(content);
          sectionCount = parsed.length;
        } catch {
          // Parse failure — still show the file, just with 0 sections
        }
      }
      files.push({ relativePath: relPath, isMarkdown, sectionCount });
    }
  };

  await walk("");
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

export async function readStagingFiles(importId: string): Promise<ImportFile[]> {
  const root = stagingFolderPath(importId);
  const results: ImportFile[] = [];

  const walk = async (relativeDir: string) => {
    const absoluteDir = path.join(root, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!relPath.toLowerCase().endsWith(".md")) continue;

      const content = await readFile(path.join(root, relPath), "utf8");
      results.push({ docPath: relPath, content });
    }
  };

  await walk("");
  results.sort((a, b) => a.docPath.localeCompare(b.docPath));
  return results;
}

export async function deleteStagingFolder(importId: string): Promise<void> {
  const folderPath = stagingFolderPath(importId);
  await rm(folderPath, { recursive: true, force: true });
}
