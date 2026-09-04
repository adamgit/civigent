import type { ActivityItem, AnyProposal } from "../../types/shared.js";
import { DocPath, FolderPath, proposalTargetDocPathForDisplay } from "../../types/shared.js";
import { HOME_RECENT_WINDOW_DAYS } from "./home-constants.js";
import { collectExistingDocPaths, countFilesInFolder, findFolderEntry, parentFolderOfDoc } from "./home-tree-stats.js";
import { getDocDisplayName } from "../document-page-utils.js";
import type { DocumentTreeEntry } from "../../types/shared.js";

export interface HomeFolderChangeCounts {
  added: number;
  modified: number;
  deleted: number;
}

export interface HomeActiveFolder {
  folderPath: FolderPath;
  name: string;
  docCount: number;
  counts: HomeFolderChangeCounts;
  lastChangedAt: string;
  /** Display names of documents that changed in the window, most recent first. */
  changedDocuments: string[];
  /** Tree used by the folder-details radial graphic; unique per folder. */
  tree: DocumentTreeEntry | null;
}

function inWindow(iso: string, nowMs: number, days: number): boolean {
  return nowMs - Date.parse(iso) <= days * 24 * 60 * 60 * 1000;
}

function displayNameForDoc(docPath: string): string {
  const parsed = DocPath.tryParse(docPath);
  return parsed ? getDocDisplayName(parsed) : docPath;
}

function changedDocumentNames(docTouched: Map<string, string>): string[] {
  return [...docTouched.entries()]
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .map(([path]) => displayNameForDoc(path));
}

/**
 * Folders with any file add / modify / delete in the recent window, newest
 * activity first. Modify is committed section activity on a path that still
 * exists in the tree the caller can see. Add/delete come from committed
 * proposals that claimed a document target (create / rename / delete). A file
 * created and then edited in the window counts toward both add and mod — those
 * two sets are not a partition. A deleted file is never also modified.
 */
export function buildActiveFolders(
  entries: DocumentTreeEntry[],
  activity: ActivityItem[],
  proposals: AnyProposal[],
  nowMs: number = Date.now(),
  windowDays: number = HOME_RECENT_WINDOW_DAYS,
): HomeActiveFolder[] {
  const existingDocs = collectExistingDocPaths(entries);
  const byFolder = new Map<
    FolderPath,
    {
      added: Set<string>;
      modified: Set<string>;
      deleted: Set<string>;
      lastChangedAt: string;
      docTouched: Map<string, string>;
    }
  >();

  const touch = (folderPath: FolderPath, iso: string) => {
    let row = byFolder.get(folderPath);
    if (!row) {
      row = {
        added: new Set(),
        modified: new Set(),
        deleted: new Set(),
        lastChangedAt: iso,
        docTouched: new Map(),
      };
      byFolder.set(folderPath, row);
    } else if (Date.parse(iso) > Date.parse(row.lastChangedAt)) {
      row.lastChangedAt = iso;
    }
    return row;
  };

  const touchDoc = (folderPath: FolderPath, iso: string, docPath: string) => {
    const row = touch(folderPath, iso);
    const prev = row.docTouched.get(docPath);
    if (!prev || Date.parse(iso) > Date.parse(prev)) row.docTouched.set(docPath, iso);
    return row;
  };

  for (const item of activity) {
    if (!inWindow(item.timestamp, nowMs, windowDays)) continue;
    for (const section of item.sections) {
      if (!existingDocs.has(section.doc_path)) continue;
      const folder = parentFolderOfDoc(section.doc_path);
      if (!folder) continue;
      touchDoc(folder, item.timestamp, section.doc_path).modified.add(section.doc_path);
    }
  }

  for (const proposal of proposals) {
    if (proposal.status !== "committed") continue;
    if (!inWindow(proposal.created_at, nowMs, windowDays)) continue;
    for (const target of proposal.targets) {
      if (target.kind !== "document") continue;
      const docPath = proposalTargetDocPathForDisplay(target);
      const folder = parentFolderOfDoc(docPath);
      if (!folder) continue;
      const row = touchDoc(folder, proposal.created_at, docPath);
      if (existingDocs.has(docPath)) row.added.add(docPath);
      else row.deleted.add(docPath);
    }
  }

  const folders: HomeActiveFolder[] = [];
  for (const [folderPath, row] of byFolder) {
    if (row.added.size === 0 && row.modified.size === 0 && row.deleted.size === 0) continue;
    folders.push({
      folderPath,
      name: FolderPath.displayName(folderPath),
      docCount: countFilesInFolder(entries, folderPath),
      counts: { added: row.added.size, modified: row.modified.size, deleted: row.deleted.size },
      lastChangedAt: row.lastChangedAt,
      changedDocuments: changedDocumentNames(row.docTouched),
      tree: findFolderEntry(entries, folderPath),
    });
  }

  folders.sort((a, b) => Date.parse(b.lastChangedAt) - Date.parse(a.lastChangedAt));
  return folders;
}

/** Tree-wide `/` card: all documents, with add/mod/del across every folder. */
export function buildAllDocsFolder(
  entries: DocumentTreeEntry[],
  activity: ActivityItem[],
  proposals: AnyProposal[],
  nowMs: number = Date.now(),
  windowDays: number = HOME_RECENT_WINDOW_DAYS,
): HomeActiveFolder {
  const existingDocs = collectExistingDocPaths(entries);
  const added = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  const docTouched = new Map<string, string>();
  let lastChangedAt = "";

  const touchTime = (iso: string, docPath?: string) => {
    if (!lastChangedAt || Date.parse(iso) > Date.parse(lastChangedAt)) lastChangedAt = iso;
    if (!docPath) return;
    const prev = docTouched.get(docPath);
    if (!prev || Date.parse(iso) > Date.parse(prev)) docTouched.set(docPath, iso);
  };

  for (const item of activity) {
    if (!inWindow(item.timestamp, nowMs, windowDays)) continue;
    for (const section of item.sections) {
      if (!existingDocs.has(section.doc_path)) continue;
      modified.add(section.doc_path);
      touchTime(item.timestamp, section.doc_path);
    }
  }

  for (const proposal of proposals) {
    if (proposal.status !== "committed") continue;
    if (!inWindow(proposal.created_at, nowMs, windowDays)) continue;
    for (const target of proposal.targets) {
      if (target.kind !== "document") continue;
      const docPath = proposalTargetDocPathForDisplay(target);
      if (existingDocs.has(docPath)) added.add(docPath);
      else deleted.add(docPath);
      touchTime(proposal.created_at, docPath);
    }
  }

  return {
    folderPath: FolderPath.root,
    name: FolderPath.displayName(FolderPath.root),
    docCount: countFilesInFolder(entries, FolderPath.root),
    counts: { added: added.size, modified: modified.size, deleted: deleted.size },
    lastChangedAt: lastChangedAt || new Date(nowMs).toISOString(),
    changedDocuments: changedDocumentNames(docTouched),
    tree: findFolderEntry(entries, FolderPath.root),
  };
}
