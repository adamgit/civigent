import path from "node:path";
import { readdir } from "node:fs/promises";
import { getContentRoot } from "./data-root.js";
import { assertChildPath } from "./path-utils.js";
import { SECTIONS_DIR_SUFFIX } from "./document-skeleton.js";
import type { DocumentTreeEntry } from "../types/shared.js";

export class DocumentsTreePathNotFoundError extends Error {}
export class InvalidDocumentsTreePathError extends Error {}

function normalizeBrowsePath(rawPath?: string): string {
  if (rawPath == null || rawPath.trim().length === 0) {
    return "/";
  }
  const slashNormalized = rawPath.replaceAll("\\", "/").trim();
  const withLeadingSlash = slashNormalized.startsWith("/") ? slashNormalized : `/${slashNormalized}`;
  const normalized = path.posix.normalize(withLeadingSlash);
  if (normalized === "." || normalized === "") {
    return "/";
  }
  if (!normalized.startsWith("/")) {
    throw new InvalidDocumentsTreePathError("Browse path must remain under root.");
  }
  if (normalized.includes("/../") || normalized === "/..") {
    throw new InvalidDocumentsTreePathError("Path traversal is not allowed.");
  }
  if (normalized !== "/" && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function toRelativeFromRoot(normalizedPath: string): string {
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
      out.push({
        type: "file",
        name: entry.name,
        path: entryPath,
      });
    }
  }

  out.sort(compareEntries);
  return out;
}

export async function readDocumentsTree(rawPath?: string, recursive?: boolean): Promise<DocumentTreeEntry[]> {
  const contentRoot = getContentRoot();
  const normalizedPath = normalizeBrowsePath(rawPath);
  const relative = toRelativeFromRoot(normalizedPath);
  const targetDir = assertChildPath(contentRoot, path.join(contentRoot, relative));

  let dirEntries;
  try {
    dirEntries = await readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // Root path with no content directory = empty store (fresh install), not an error.
      if (normalizedPath === "/") {
        return [];
      }
      throw new DocumentsTreePathNotFoundError(`Browse path not found: ${normalizedPath}`);
    }
    throw error;
  }

  const recursiveListing = recursive ?? (rawPath == null || rawPath.trim().length === 0);

  if (!dirEntries) {
    throw new DocumentsTreePathNotFoundError(`Browse path not found: ${normalizedPath}`);
  }

  return buildEntries(normalizedPath, targetDir, recursiveListing);
}
