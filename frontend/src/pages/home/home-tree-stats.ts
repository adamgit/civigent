import { FolderPath, type DocumentTreeEntry } from "../../types/shared.js";

export function countTreeTotals(entries: DocumentTreeEntry[]): { folderCount: number; documentCount: number } {
  let folderCount = 0;
  let documentCount = 0;
  for (const entry of entries) {
    if (entry.type === "directory") {
      folderCount += 1;
      documentCount += countFilesInSubtree(entry);
    } else {
      documentCount += 1;
    }
  }
  return { folderCount, documentCount };
}

export function countFilesInFolder(entries: DocumentTreeEntry[], folderPath: FolderPath): number {
  const folder = findFolderEntry(entries, folderPath);
  if (!folder) return 0;
  return countFilesInSubtree(folder);
}

export function collectExistingDocPaths(entries: DocumentTreeEntry[]): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: DocumentTreeEntry[]) => {
    for (const node of nodes) {
      if (node.type === "file") out.add(node.path);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(entries);
  return out;
}

function countFilesInSubtree(entry: DocumentTreeEntry): number {
  if (entry.type === "file") return 1;
  let count = 0;
  for (const child of entry.children ?? []) {
    count += countFilesInSubtree(child);
  }
  return count;
}

function findFolderEntry(entries: DocumentTreeEntry[], folderPath: FolderPath): DocumentTreeEntry | null {
  if (folderPath === FolderPath.root) {
    return { type: "directory", name: "/", path: FolderPath.root, children: entries };
  }
  const stack = [...entries];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "directory" && node.path === folderPath) return node;
    if (node.type === "directory" && node.children?.length) stack.push(...node.children);
  }
  return null;
}

export function parentFolderOfDoc(docPath: string): FolderPath | null {
  const lastSlash = docPath.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return FolderPath.tryParse(docPath.slice(0, lastSlash));
}

export function folderPrefixOfDoc(docPath: string): string {
  const lastSlash = docPath.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return `${docPath.slice(0, lastSlash)}/`;
}
