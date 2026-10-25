import path from "node:path";
import type { DocumentTreeEntry } from "../types/shared.js";
import { SECTIONS_DIR_SUFFIX, TOMBSTONE_SUFFIX } from "./document-skeleton.js";
import { readDirentsIfExists } from "./fs-primitives.js";
import { docPathFromContentRelativeFsPath } from "./path-utils.js";
import { listInProgressProposals, proposalContentRoot } from "./proposal-repository.js";
import {
  compareDocumentTreeEntries,
  DocumentsTreePathNotFoundError,
  readCanonicalDocumentsTree,
  resolveDocumentsTreeBrowse,
  skeletonDocumentSizeBytes,
} from "./documents-tree.js";

type OverlaySkeleton = { size_bytes: number };

export type InprogressUnpublished = {
  overlaySkeletons: Map<string, OverlaySkeleton>;
  tombstones: Set<string>;
  targets: Set<string>;
};

/**
 * Disk facts from `inprogress` proposals only. Does not use file ages and does
 * not open a workspace document reader.
 */
export async function scanInprogressUnpublished(): Promise<InprogressUnpublished> {
  const overlaySkeletons = new Map<string, OverlaySkeleton>();
  const tombstones = new Set<string>();
  const targets = new Set<string>();

  for (const proposal of await listInProgressProposals()) {
    for (const target of proposal.targets) {
      targets.add(target.doc_path);
    }
    const overlayRoot = proposalContentRoot(proposal.id, "inprogress");
    for (const entry of await readDirentsIfExists(overlayRoot, { recursive: true })) {
      if (!entry.isFile()) continue;
      const relPath = path
        .relative(overlayRoot, path.join(entry.parentPath, entry.name))
        .replace(/\\/g, "/");
      if (relPath.split("/").slice(0, -1).some((segment) => segment.endsWith(SECTIONS_DIR_SUFFIX))) {
        continue;
      }
      if (entry.name.endsWith(TOMBSTONE_SUFFIX)) {
        tombstones.add(docPathFromContentRelativeFsPath(relPath.slice(0, -TOMBSTONE_SUFFIX.length)));
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const docPath = docPathFromContentRelativeFsPath(relPath);
      if (overlaySkeletons.has(docPath)) continue;
      overlaySkeletons.set(docPath, {
        size_bytes: await skeletonDocumentSizeBytes(path.join(entry.parentPath, entry.name)),
      });
    }
  }

  return { overlaySkeletons, tombstones, targets };
}

function collectFilePaths(entries: DocumentTreeEntry[]): Set<string> {
  const paths = new Set<string>();
  const walk = (nodes: DocumentTreeEntry[]): void => {
    for (const node of nodes) {
      if (node.type === "file") {
        paths.add(node.path);
        continue;
      }
      walk(node.children ?? []);
    }
  };
  walk(entries);
  return paths;
}

function cloneTree(entries: DocumentTreeEntry[]): DocumentTreeEntry[] {
  return entries.map((entry) =>
    entry.type === "directory"
      ? { ...entry, children: entry.children ? cloneTree(entry.children) : entry.children }
      : { ...entry },
  );
}

function parentFolderOfDocPath(docPath: string): string {
  const lastSlash = docPath.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : docPath.slice(0, lastSlash);
}

function fileNameOfDocPath(docPath: string): string {
  return docPath.slice(docPath.lastIndexOf("/") + 1);
}

function isUnderBrowseFolder(browsePath: string, docPath: string): boolean {
  return browsePath === "/" || docPath.startsWith(`${browsePath}/`);
}

function isInBrowseScope(browsePath: string, docPath: string, recursive: boolean): boolean {
  if (!isUnderBrowseFolder(browsePath, docPath)) return false;
  return recursive || parentFolderOfDocPath(docPath) === browsePath;
}

function immediateChildFolder(browsePath: string, docPath: string): string | null {
  if (!isUnderBrowseFolder(browsePath, docPath)) return null;
  const rest = browsePath === "/" ? docPath.slice(1) : docPath.slice(browsePath.length + 1);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const segment = rest.slice(0, slash);
  return browsePath === "/" ? `/${segment}` : `${browsePath}/${segment}`;
}

function ensureChildDirectory(
  siblings: DocumentTreeEntry[],
  dirPath: string,
  name: string,
  withChildren: boolean,
): DocumentTreeEntry {
  const existing = siblings.find((entry) => entry.type === "directory" && entry.path === dirPath);
  if (existing) {
    if (withChildren) existing.children ??= [];
    return existing;
  }
  const created: DocumentTreeEntry = {
    type: "directory",
    name,
    path: dirPath,
    ...(withChildren ? { children: [] } : {}),
  };
  siblings.push(created);
  siblings.sort(compareDocumentTreeEntries);
  return created;
}

function directoryChildren(
  entries: DocumentTreeEntry[],
  browsePath: string,
  folderPath: string,
): DocumentTreeEntry[] {
  if (folderPath === browsePath) return entries;
  const prefix = browsePath === "/" ? "" : browsePath;
  const segments = folderPath.slice(prefix.length).split("/").filter(Boolean);
  let siblings = entries;
  let currentPath = browsePath;
  for (const segment of segments) {
    currentPath = currentPath === "/" ? `/${segment}` : `${currentPath}/${segment}`;
    const dir = ensureChildDirectory(siblings, currentPath, segment, true);
    dir.children ??= [];
    siblings = dir.children;
  }
  return siblings;
}

function mergeOverlaySkeletons(
  tree: DocumentTreeEntry[],
  browsePath: string,
  recursive: boolean,
  skeletons: Map<string, OverlaySkeleton>,
): DocumentTreeEntry[] {
  const out = cloneTree(tree);
  const existing = collectFilePaths(out);
  for (const [docPath, meta] of skeletons) {
    if (existing.has(docPath)) continue;
    if (isInBrowseScope(browsePath, docPath, recursive)) {
      const siblings = directoryChildren(out, browsePath, parentFolderOfDocPath(docPath));
      siblings.push({
        type: "file",
        name: fileNameOfDocPath(docPath),
        path: docPath,
        size_bytes: meta.size_bytes,
      });
      siblings.sort(compareDocumentTreeEntries);
      existing.add(docPath);
      continue;
    }
    if (recursive) continue;
    const childFolder = immediateChildFolder(browsePath, docPath);
    if (childFolder) {
      ensureChildDirectory(out, childFolder, fileNameOfDocPath(childFolder), false);
    }
  }
  return out;
}

function workspaceFileMark(
  docPath: string,
  canonicalPaths: Set<string>,
  unpublished: InprogressUnpublished,
): "new" | "modified" | undefined {
  if (!canonicalPaths.has(docPath)) return "new";
  if (
    unpublished.overlaySkeletons.has(docPath) ||
    unpublished.tombstones.has(docPath) ||
    unpublished.targets.has(docPath)
  ) {
    return "modified";
  }
  return undefined;
}

function applyWorkspaceFileMarks(
  entries: DocumentTreeEntry[],
  canonicalPaths: Set<string>,
  unpublished: InprogressUnpublished,
): DocumentTreeEntry[] {
  return entries.map((entry) => {
    if (entry.type === "directory") {
      return {
        ...entry,
        children: entry.children
          ? applyWorkspaceFileMarks(entry.children, canonicalPaths, unpublished)
          : entry.children,
      };
    }
    const mark = workspaceFileMark(entry.path, canonicalPaths, unpublished);
    return mark === undefined ? entry : { ...entry, mark };
  });
}

/**
 * Canonical committed skeletons plus every `.md` skeleton under an `inprogress`
 * proposal content root. Same path from several proposals is one row. A
 * tombstone does not remove a committed row.
 */
export async function readWorkspaceDocumentsTree(
  rawPath?: string,
  recursive?: boolean,
): Promise<DocumentTreeEntry[]> {
  const { browsePath, recursive: recursiveListing } = resolveDocumentsTreeBrowse(rawPath, recursive);
  let canonical: DocumentTreeEntry[];
  let canonicalMissing = false;
  try {
    canonical = await readCanonicalDocumentsTree(rawPath, recursive);
  } catch (error) {
    if (!(error instanceof DocumentsTreePathNotFoundError) || browsePath === "/") {
      throw error;
    }
    canonical = [];
    canonicalMissing = true;
  }

  const unpublished = await scanInprogressUnpublished();
  const merged = mergeOverlaySkeletons(
    canonical,
    browsePath,
    recursiveListing,
    unpublished.overlaySkeletons,
  );
  if (canonicalMissing && merged.length === 0) {
    throw new DocumentsTreePathNotFoundError(`Browse path not found: ${browsePath}`);
  }
  return applyWorkspaceFileMarks(merged, collectFilePaths(canonical), unpublished);
}
