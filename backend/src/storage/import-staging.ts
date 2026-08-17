/**
 * import-staging.ts — Staging record infrastructure for imports.
 *
 * All state is on disk — no in-memory map. Each import is a record directory
 * under /app/data/import-staging/{uuid}/ holding `meta.json` (destination
 * folder + creation time, the proposals meta.json idiom) beside a `files/`
 * root that contains only the user's staged files. Content walkers only ever
 * enter `files/`, so record-level artifacts (meta.json, the zip spool) are
 * structurally invisible to them — no reserved-name skip lists. Survives
 * server restarts with no reconstruction needed.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readDirentsIfExists } from "./fs-primitives.js";
import { getImportStagingRoot } from "./data-root.js";
import { parseDocumentMarkdown } from "./markdown-sections.js";
import { FolderPath, InvalidFolderPathError } from "../types/shared.js";
import {
  findDuplicateHeadingPathLabels,
  resolutionsForMarkdown,
  type DuplicateBodyConflictPreview,
} from "./import-resolutions.js";

export { getImportStagingRoot } from "./data-root.js";

function stagingRecordPath(importId: string): string {
  return path.join(getImportStagingRoot(), importId);
}

export function stagingFilesRoot(importId: string): string {
  return path.join(stagingRecordPath(importId), "files");
}

function stagingMetaPath(importId: string): string {
  return path.join(stagingRecordPath(importId), "meta.json");
}

export function stagingZipSpoolPath(importId: string): string {
  return path.join(stagingRecordPath(importId), ".incoming.zip");
}

// ─── Public types ────────────────────────────────────────

export class ImportStagingMetaError extends Error {}

export class ImportStagingPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportStagingPathError";
  }
}

export interface ImportResolutionChoice {
  id: string;
  label: string;
  preview?: DuplicateBodyConflictPreview;
}

export interface ImportStagingMeta {
  targetFolder: FolderPath;
  createdAt: string;
}

export interface StagingFolderInfo {
  importId: string;
  stagingPath: string;
  createdAt: string;
  targetFolder: FolderPath;
}

export interface StagingFileInfo {
  relativePath: string;
  isMarkdown: boolean;
  sectionCount: number;
  /**
   * True when the file is a Civigent internal-format artifact: either a skeleton file
   * (an .md file with a sibling .sections/ directory) or any file inside a .sections/ directory.
   */
  isInternalArtifact: boolean;
  /**
   * Human-readable reason why this file cannot be imported, or null if it is valid.
   */
  rejectionReason: string | null;
  /**
   * Salvage algorithms that apply() can run on this file's current bytes.
   * Empty when the file is importable, or when no registered resolution fits.
   */
  applicableResolutions: ImportResolutionChoice[];
}

// ─── meta.json read/decode ───────────────────────────────

function decodeImportStagingMeta(raw: unknown, importId: string): ImportStagingMeta {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ImportStagingMetaError(`Import ${importId} meta.json is not an object.`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.target_folder !== "string") {
    throw new ImportStagingMetaError(`Import ${importId} meta.json is missing target_folder.`);
  }
  let targetFolder: FolderPath;
  try {
    targetFolder = FolderPath.parse(record.target_folder);
  } catch (error) {
    if (error instanceof InvalidFolderPathError) {
      throw new ImportStagingMetaError(`Import ${importId} meta.json target_folder: ${error.message}`);
    }
    throw error;
  }
  if (typeof record.created_at !== "string" || record.created_at.length === 0) {
    throw new ImportStagingMetaError(`Import ${importId} meta.json is missing created_at.`);
  }
  return { targetFolder, createdAt: record.created_at };
}

async function readImportStagingMetaIfPresent(importId: string): Promise<ImportStagingMeta | null> {
  let content: string;
  try {
    content = await readFile(stagingMetaPath(importId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ImportStagingMetaError(
      `Import ${importId} meta.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new ImportStagingMetaError(
      `Import ${importId} meta.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return decodeImportStagingMeta(raw, importId);
}

export async function readImportStagingMeta(importId: string): Promise<ImportStagingMeta> {
  const meta = await readImportStagingMetaIfPresent(importId);
  if (meta === null) {
    throw new ImportStagingMetaError(`Import ${importId} has no meta.json.`);
  }
  return meta;
}

// ─── Public API ──────────────────────────────────────────

export async function createStagingFolder(
  targetFolder: FolderPath,
): Promise<{ importId: string; stagingPath: string }> {
  const importId = randomUUID();
  await mkdir(stagingFilesRoot(importId), { recursive: true });
  await writeFile(
    stagingMetaPath(importId),
    JSON.stringify({ target_folder: targetFolder, created_at: new Date().toISOString() }, null, 2),
    "utf8",
  );
  return { importId, stagingPath: stagingRecordPath(importId) };
}

export async function listStagingFolders(): Promise<StagingFolderInfo[]> {
  const root = getImportStagingRoot();
  // An absent staging root means no staging folders exist yet.
  const entries = await readDirentsIfExists(root);

  const results: StagingFolderInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // A record directory without a meta.json is a mid-creation partial and is
    // skipped; a present-but-corrupt meta.json surfaces (decoding throws).
    const meta = await readImportStagingMetaIfPresent(entry.name);
    if (meta === null) continue;
    results.push({
      importId: entry.name,
      stagingPath: path.join(root, entry.name),
      createdAt: meta.createdAt,
      targetFolder: meta.targetFolder,
    });
  }
  return results;
}

export async function scanStagingFolder(importId: string): Promise<StagingFileInfo[]> {
  const root = stagingFilesRoot(importId);
  const files: StagingFileInfo[] = [];
  // Collect relative paths of all .sections/ directories so we can flag artifacts
  const sectionsDirs = new Set<string>();

  const walk = async (relativeDir: string) => {
    const absoluteDir = path.join(root, relativeDir);
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".sections")) {
          sectionsDirs.add(relPath);
        }
        await walk(relPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const isMarkdown = relPath.toLowerCase().endsWith(".md");
      let sectionCount = 0;
      let rejectionReason: string | null = isMarkdown
        ? null
        : "Unsupported file type. Only .md (Markdown) files can be imported.";
      let applicableResolutions: ImportResolutionChoice[] = [];
      if (isMarkdown) {
        try {
          const content = await readFile(path.join(root, relPath), "utf8");
          const parsed = parseDocumentMarkdown(content);
          sectionCount = parsed.length;
          const duplicatePaths = findDuplicateHeadingPathLabels(parsed);
          if (duplicatePaths.length > 0) {
            rejectionReason = `Duplicate heading path: ${duplicatePaths.join("; ")}`;
            applicableResolutions = resolutionsForMarkdown(content).map((resolution) => ({
              id: resolution.id,
              label: resolution.label,
              ...(resolution.preview ? { preview: resolution.preview(content) } : {}),
            }));
          }
        } catch {
          // Parse failure — still show the file, just with 0 sections
        }
      }
      files.push({
        relativePath: relPath,
        isMarkdown,
        sectionCount,
        isInternalArtifact: false,
        rejectionReason,
        applicableResolutions,
      });
    }
  };

  await walk("");

  // Mark artifacts: any file inside a .sections/ directory, AND the skeleton
  // sibling (the .md file whose name + ".sections" matches a directory).
  if (sectionsDirs.size > 0) {
    // Build set of skeleton paths: for "foo.md.sections" the skeleton is "foo.md"
    const skeletonPaths = new Set<string>();
    for (const dir of sectionsDirs) {
      if (dir.endsWith(".sections")) {
        skeletonPaths.add(dir.slice(0, -".sections".length));
      }
    }

    const artifactRejection =
      "Civigent internal-format file (skeleton or .sections/ artifact) — these cannot be imported. You probably meant to copy from the snapshots folder instead.";
    for (const f of files) {
      if (skeletonPaths.has(f.relativePath)) {
        f.isInternalArtifact = true;
        f.rejectionReason = artifactRejection;
        f.applicableResolutions = [];
        continue;
      }
      for (const dir of sectionsDirs) {
        if (f.relativePath.startsWith(dir + "/")) {
          f.isInternalArtifact = true;
          f.rejectionReason = artifactRejection;
          f.applicableResolutions = [];
          break;
        }
      }
    }
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

export interface StagedMarkdownFile {
  relativePath: string;
  content: string;
}

export async function readStagingFiles(importId: string): Promise<StagedMarkdownFile[]> {
  const root = stagingFilesRoot(importId);
  const results: StagedMarkdownFile[] = [];

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
      results.push({ relativePath: relPath, content });
    }
  };

  await walk("");
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

function resolveExistingStagingFilePath(importId: string, relativePath: string): string {
  const filesRoot = stagingFilesRoot(importId);
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const pathSegments = normalized.split("/");
  if (
    normalized.length === 0 ||
    pathSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ImportStagingPathError(`Invalid file path: ${relativePath}`);
  }
  const filePath = path.resolve(filesRoot, ...pathSegments);
  if (filePath === filesRoot || !filePath.startsWith(filesRoot + path.sep)) {
    throw new ImportStagingPathError(`Invalid file path: ${relativePath}`);
  }
  return filePath;
}

export async function readStagingFile(importId: string, relativePath: string): Promise<string> {
  try {
    return await readFile(resolveExistingStagingFilePath(importId, relativePath), "utf8");
  } catch (error) {
    if (error instanceof ImportStagingPathError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ImportStagingPathError(`File not in this import: ${relativePath}`);
    }
    throw error;
  }
}

export async function writeStagingFile(importId: string, relativePath: string, content: string): Promise<void> {
  const filePath = resolveExistingStagingFilePath(importId, relativePath);
  try {
    await access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ImportStagingPathError(`File not in this import: ${relativePath}`);
    }
    throw error;
  }
  await writeFile(filePath, content, "utf8");
}

export async function deleteStagingFolder(importId: string): Promise<void> {
  await rm(stagingRecordPath(importId), { recursive: true, force: true });
}
