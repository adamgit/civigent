import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { directoryExists } from "./fs-primitives.js";
import { getContentRoot } from "./data-root.js";
import { assertChildPath } from "./path-utils.js";
import { SECTIONS_DIR_SUFFIX } from "./document-skeleton.js";
import type { DocumentTreeEntry } from "../types/shared.js";
import { FolderPath, InvalidFolderPathError } from "../types/shared.js";

export class DocumentsTreePathNotFoundError extends Error {}
export class InvalidDocumentsTreePathError extends Error {}

function normalizeBrowsePath(rawPath?: string): string {
  try {
    return FolderPath.normalize(rawPath);
  } catch (error) {
    if (error instanceof InvalidFolderPathError) {
      throw new InvalidDocumentsTreePathError(error.message);
    }
    throw error;
  }
}

export function browseFolderPathToContentRelativeFsPath(normalizedPath: string): string {
  if (normalizedPath === "/") {
    return "";
  }
  return normalizedPath.replace(/^\/+/, "");
}

function shouldIncludeDirectory(name: string): boolean {
  return !name.endsWith(SECTIONS_DIR_SUFFIX);
}

function shouldIncludeFile(name: string): boolean {
  return name.endsWith(".md");
}

function compareEntries(a: DocumentTreeEntry, b: DocumentTreeEntry): number {
  if (a.type !== b.type) {
    return a.type === "directory" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/** Sum sizes of regular files under `dir` (recursive). Missing dir → 0. */
async function sumFileBytesRecursive(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sumFileBytesRecursive(absolute);
      continue;
    }
    if (entry.isFile()) {
      try {
        total += (await stat(absolute)).size;
      } catch {
        // Skip unreadable entries; size is a best-effort UI signal.
      }
    }
  }
  return total;
}

/**
 * Cheap approximate document mass: skeleton file bytes + all files under its
 * `.sections` tree. Not assembled markdown length — good enough for relative UI.
 */
async function approxDocumentSizeBytes(absoluteSkeletonPath: string): Promise<number> {
  let total = 0;
  try {
    total += (await stat(absoluteSkeletonPath)).size;
  } catch {
    return 0;
  }
  total += await sumFileBytesRecursive(`${absoluteSkeletonPath}${SECTIONS_DIR_SUFFIX}`);
  return total;
}

async function buildEntries(currentPath: string, absolutePath: string, recursive: boolean): Promise<DocumentTreeEntry[]> {
  const dirEntries = await readdir(absolutePath, { withFileTypes: true });
  const out: DocumentTreeEntry[] = [];

  for (const entry of dirEntries) {
    const entryPath = currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!shouldIncludeDirectory(entry.name)) {
        continue;
      }
      const childAbsolute = assertChildPath(absolutePath, path.join(absolutePath, entry.name));
      const child: DocumentTreeEntry = {
        type: "directory",
        name: entry.name,
        path: entryPath,
      };
      if (recursive) {
        child.children = await buildEntries(entryPath, childAbsolute, true);
      }
      out.push(child);
      continue;
    }

    if (entry.isFile() && shouldIncludeFile(entry.name)) {
      const absoluteFile = assertChildPath(absolutePath, path.join(absolutePath, entry.name));
      out.push({
        type: "file",
        name: entry.name,
        path: entryPath,
        size_bytes: await approxDocumentSizeBytes(absoluteFile),
      });
    }
  }

  out.sort(compareEntries);
  return out;
}

export async function readDocumentsTree(rawPath?: string, recursive?: boolean): Promise<DocumentTreeEntry[]> {
  const contentRoot = getContentRoot();
  const normalizedPath = normalizeBrowsePath(rawPath);
  const relative = browseFolderPathToContentRelativeFsPath(normalizedPath);
  const targetDir = assertChildPath(contentRoot, path.join(contentRoot, relative));

  if (!(await directoryExists(targetDir))) {
    // Root path with no content directory = empty store (fresh install), not an error.
    if (normalizedPath === "/") {
      return [];
    }
    throw new DocumentsTreePathNotFoundError(`Browse path not found: ${normalizedPath}`);
  }

  const recursiveListing = recursive ?? (rawPath == null || rawPath.trim().length === 0);
  return buildEntries(normalizedPath, targetDir, recursiveListing);
}
