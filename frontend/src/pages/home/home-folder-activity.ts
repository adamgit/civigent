import type { ActivityItem, WriterType } from "../../types/shared.js";
import { DocPath, FolderPath } from "../../types/shared.js";
import { HOME_RECENT_WINDOW_DAYS } from "./home-constants.js";
import { collectExistingDocPaths, countFilesInFolder, findFolderEntry, parentFolderOfDoc } from "./home-tree-stats.js";
import { getDocDisplayName, headingText } from "../document-page-utils.js";
import type { DocumentTreeEntry } from "../../types/shared.js";
import { activityItemInWindow, rangeOverlapsWindow } from "./home-time.js";

export interface HomeFolderChangeCounts {
  added: number;
  modified: number;
  deleted: number;
}

export type HomeFolderDocChangeKind = "added" | "modified" | "deleted";

export interface HomeFolderChangedDocument {
  path: string;
  title: string;
  kinds: HomeFolderDocChangeKind[];
  lastChangedAt: string;
  lastWriterName: string;
  writers: string[];
  sections: string[];
  lastIntent?: string;
}

export interface HomeActiveFolder {
  folderPath: FolderPath;
  name: string;
  docCount: number;
  counts: HomeFolderChangeCounts;
  lastChangedAt: string;
  writerKind: WriterType;
  /** Documents that changed in the window, most recent first. */
  changedDocuments: HomeFolderChangedDocument[];
  /** Tree used by the folder-details radial graphic; unique per folder. */
  tree: DocumentTreeEntry | null;
}

interface DocTouchAgg {
  lastChangedAt: string;
  lastWriterName: string;
  writers: Set<string>;
  sections: string[];
  lastIntent?: string;
}

function pointInWindow(iso: string, windowStartMs: number, windowEndMs: number): boolean {
  return rangeOverlapsWindow(Date.parse(iso), undefined, windowStartMs, windowEndMs);
}

function displayNameForDoc(docPath: string): string {
  const parsed = DocPath.tryParse(docPath);
  return parsed ? getDocDisplayName(parsed) : docPath;
}

function sectionLabel(headingPath: string[]): string | null {
  if (headingPath.length === 0) return null;
  const text = headingText(headingPath);
  return text.length > 0 ? text : null;
}

function recordDocTouch(
  docs: Map<string, DocTouchAgg>,
  docPath: string,
  iso: string,
  writerName: string,
  intent: string | undefined,
  headingPath?: string[],
): void {
  let agg = docs.get(docPath);
  if (!agg) {
    agg = {
      lastChangedAt: iso,
      lastWriterName: writerName,
      writers: new Set([writerName]),
      sections: [],
      lastIntent: intent,
    };
    docs.set(docPath, agg);
  } else {
    agg.writers.add(writerName);
    if (Date.parse(iso) >= Date.parse(agg.lastChangedAt)) {
      agg.lastChangedAt = iso;
      agg.lastWriterName = writerName;
      if (intent) agg.lastIntent = intent;
    } else if (intent && !agg.lastIntent) {
      agg.lastIntent = intent;
    }
  }
  if (!headingPath) return;
  const label = sectionLabel(headingPath);
  if (label && !agg.sections.includes(label)) agg.sections.push(label);
}

function toChangedDocuments(
  added: Set<string>,
  modified: Set<string>,
  deleted: Set<string>,
  docs: Map<string, DocTouchAgg>,
): HomeFolderChangedDocument[] {
  const paths = new Set([...added, ...modified, ...deleted]);
  const items: HomeFolderChangedDocument[] = [];
  for (const path of paths) {
    const kinds: HomeFolderDocChangeKind[] = [];
    if (added.has(path)) kinds.push("added");
    if (modified.has(path)) kinds.push("modified");
    if (deleted.has(path)) kinds.push("deleted");
    const agg = docs.get(path);
    items.push({
      path,
      title: displayNameForDoc(path),
      kinds,
      lastChangedAt: agg?.lastChangedAt ?? "",
      lastWriterName: agg?.lastWriterName ?? "",
      writers: agg ? [...agg.writers] : [],
      sections: agg?.sections ?? [],
      lastIntent: agg?.lastIntent,
    });
  }
  items.sort((a, b) => Date.parse(b.lastChangedAt) - Date.parse(a.lastChangedAt));
  return items;
}

/**
 * Folders with any file add / modify / delete in the recent window, newest
 * activity first. A folder appears once per writer kind that touched it —
 * newest human land and newest agent land are separate rows. Modify is
 * committed section activity on a path that still exists in the tree the
 * caller can see. Add/delete come from committed proposals that claimed a
 * document target (create / rename / delete). A file created and then edited
 * in the window counts toward both add and mod — those two sets are not a
 * partition. A deleted file is never also modified. Counts and touched names
 * stay on the writer-kind row that produced them.
 */
export function buildActiveFolders(
  entries: DocumentTreeEntry[],
  activity: ActivityItem[],
  nowMs: number = Date.now(),
  windowDays: number = HOME_RECENT_WINDOW_DAYS,
): HomeActiveFolder[] {
  const existingDocs = collectExistingDocPaths(entries);
  const byFolderKind = new Map<
    string,
    {
      folderPath: FolderPath;
      writerKind: WriterType;
      added: Set<string>;
      modified: Set<string>;
      deleted: Set<string>;
      lastChangedAt: string;
      docs: Map<string, DocTouchAgg>;
    }
  >();

  const touch = (folderPath: FolderPath, writerKind: WriterType, iso: string) => {
    const key = `${folderPath}\0${writerKind}`;
    let row = byFolderKind.get(key);
    if (!row) {
      row = {
        folderPath,
        writerKind,
        added: new Set(),
        modified: new Set(),
        deleted: new Set(),
        lastChangedAt: iso,
        docs: new Map(),
      };
      byFolderKind.set(key, row);
    } else if (Date.parse(iso) > Date.parse(row.lastChangedAt)) {
      row.lastChangedAt = iso;
    }
    return row;
  };

  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  for (const item of activity) {
    if (!activityItemInWindow(item, windowStartMs, nowMs)) continue;
    for (const section of item.sections) {
      if (!existingDocs.has(section.doc_path)) continue;
      const folder = parentFolderOfDoc(section.doc_path);
      if (!folder) continue;
      const row = touch(folder, item.writer_type, item.timestamp);
      recordDocTouch(
        row.docs,
        section.doc_path,
        item.timestamp,
        item.writer_display_name,
        item.intent,
        section.heading_path,
      );
      row.modified.add(section.doc_path);
    }
  }

  for (const item of activity) {
    if (!pointInWindow(item.landed_at, windowStartMs, nowMs)) continue;
    for (const docPath of item.document_paths) {
      const folder = parentFolderOfDoc(docPath);
      if (!folder) continue;
      const row = touch(folder, item.writer_type, item.landed_at);
      recordDocTouch(row.docs, docPath, item.landed_at, item.writer_display_name, item.intent);
      if (existingDocs.has(docPath)) row.added.add(docPath);
      else row.deleted.add(docPath);
    }
  }

  const folders: HomeActiveFolder[] = [];
  for (const row of byFolderKind.values()) {
    if (row.added.size === 0 && row.modified.size === 0 && row.deleted.size === 0) continue;
    folders.push({
      folderPath: row.folderPath,
      name: FolderPath.displayName(row.folderPath),
      docCount: countFilesInFolder(entries, row.folderPath),
      counts: { added: row.added.size, modified: row.modified.size, deleted: row.deleted.size },
      lastChangedAt: row.lastChangedAt,
      writerKind: row.writerKind,
      changedDocuments: toChangedDocuments(row.added, row.modified, row.deleted, row.docs),
      tree: findFolderEntry(entries, row.folderPath),
    });
  }

  folders.sort((a, b) => Date.parse(b.lastChangedAt) - Date.parse(a.lastChangedAt));
  return folders;
}

/** Tree-wide `/` card: all documents, with add/mod/del across every folder. */
export function buildAllDocsFolder(
  entries: DocumentTreeEntry[],
  activity: ActivityItem[],
  nowMs: number = Date.now(),
  windowDays: number = HOME_RECENT_WINDOW_DAYS,
): HomeActiveFolder {
  const existingDocs = collectExistingDocPaths(entries);
  const added = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  const docs = new Map<string, DocTouchAgg>();
  let lastChangedAt = "";

  const touchTime = (iso: string) => {
    if (!lastChangedAt || Date.parse(iso) > Date.parse(lastChangedAt)) lastChangedAt = iso;
  };

  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  for (const item of activity) {
    if (!activityItemInWindow(item, windowStartMs, nowMs)) continue;
    for (const section of item.sections) {
      if (!existingDocs.has(section.doc_path)) continue;
      modified.add(section.doc_path);
      touchTime(item.timestamp);
      recordDocTouch(
        docs,
        section.doc_path,
        item.timestamp,
        item.writer_display_name,
        item.intent,
        section.heading_path,
      );
    }
  }

  for (const item of activity) {
    if (!pointInWindow(item.landed_at, windowStartMs, nowMs)) continue;
    for (const docPath of item.document_paths) {
      if (existingDocs.has(docPath)) added.add(docPath);
      else deleted.add(docPath);
      touchTime(item.landed_at);
      recordDocTouch(docs, docPath, item.landed_at, item.writer_display_name, item.intent);
    }
  }

  return {
    folderPath: FolderPath.root,
    name: FolderPath.displayName(FolderPath.root),
    docCount: countFilesInFolder(entries, FolderPath.root),
    counts: { added: added.size, modified: modified.size, deleted: deleted.size },
    lastChangedAt: lastChangedAt || new Date(nowMs).toISOString(),
    writerKind: "human",
    changedDocuments: toChangedDocuments(added, modified, deleted, docs),
    tree: findFolderEntry(entries, FolderPath.root),
  };
}
