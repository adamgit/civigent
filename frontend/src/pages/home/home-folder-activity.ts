import type { ActivityItem, AnyProposal } from "../../types/shared.js";
import { FolderPath, proposalTargetDocPathForDisplay } from "../../types/shared.js";
import { HOME_RECENT_WINDOW_DAYS } from "./home-constants.js";
import { collectExistingDocPaths, countFilesInFolder, parentFolderOfDoc } from "./home-tree-stats.js";
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
}

function inWindow(iso: string, nowMs: number, days: number): boolean {
  return nowMs - Date.parse(iso) <= days * 24 * 60 * 60 * 1000;
}

/**
 * Folders with any file add / modify / delete in the recent window, newest
 * activity first. Modify comes from committed section activity; add/delete
 * from committed proposals that claimed a document target (create / rename /
 * delete). A file created and then edited in the window counts toward both
 * add and mod — the bars are ratios of those three sets, not a partition.
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
    { added: Set<string>; modified: Set<string>; deleted: Set<string>; lastChangedAt: string }
  >();

  const touch = (folderPath: FolderPath, iso: string) => {
    let row = byFolder.get(folderPath);
    if (!row) {
      row = { added: new Set(), modified: new Set(), deleted: new Set(), lastChangedAt: iso };
      byFolder.set(folderPath, row);
    } else if (Date.parse(iso) > Date.parse(row.lastChangedAt)) {
      row.lastChangedAt = iso;
    }
    return row;
  };

  for (const item of activity) {
    if (!inWindow(item.timestamp, nowMs, windowDays)) continue;
    for (const section of item.sections) {
      const folder = parentFolderOfDoc(section.doc_path);
      if (!folder) continue;
      touch(folder, item.timestamp).modified.add(section.doc_path);
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
      const row = touch(folder, proposal.created_at);
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
  let lastChangedAt = "";

  const touchTime = (iso: string) => {
    if (!lastChangedAt || Date.parse(iso) > Date.parse(lastChangedAt)) lastChangedAt = iso;
  };

  for (const item of activity) {
    if (!inWindow(item.timestamp, nowMs, windowDays)) continue;
    for (const section of item.sections) {
      modified.add(section.doc_path);
      touchTime(item.timestamp);
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
      touchTime(proposal.created_at);
    }
  }

  return {
    folderPath: FolderPath.root,
    name: FolderPath.displayName(FolderPath.root),
    docCount: countFilesInFolder(entries, FolderPath.root),
    counts: { added: added.size, modified: modified.size, deleted: deleted.size },
    lastChangedAt: lastChangedAt || new Date(nowMs).toISOString(),
  };
}
