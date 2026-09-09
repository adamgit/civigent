import type { ActivityItem, WriterType } from "../../types/shared.js";
import { HOME_RECENT_WINDOW_DAYS } from "./home-constants.js";
import { folderPrefixOfDoc } from "./home-tree-stats.js";
import { getDocDisplayName, headingText } from "../document-page-utils.js";
import { DocPath } from "../../types/shared.js";
import { activityItemInWindow } from "./home-time.js";

export type HomeDocChangeKind = "rewritten" | "added" | "moved";

export interface HomeDocChangeGroup {
  kind: HomeDocChangeKind;
  headings: string[];
}

export interface HomeRecentDocument {
  docPath: string;
  title: string;
  folderPrefix: string;
  writerName: string;
  writerId: string;
  writerKind: WriterType;
  timestamp: string;
  yours: boolean;
  changes: HomeDocChangeGroup[];
}

function sectionLabel(headingPath: string[]): string | null {
  if (headingPath.length === 0) return null;
  const text = headingText(headingPath);
  return text.length > 0 ? text : null;
}

/**
 * Up to two cards per document in the window — one for the newest human
 * land, one for the newest agent land — mixed newest-first. Not sliced:
 * the home section paginates after partitioning so a wide Yours/Everyone-else
 * split can page each column independently.
 *
 * Activity items are committed proposals: they name the claimed heading paths
 * but do not record whether each path was a write, a create, or a move. Those
 * kinds are not persisted on the proposal manifest (create/write/move all
 * union into `sections`). Until a richer claim exists, every named heading is
 * shown as rewritten — the card still renders added/moved rows when a later
 * source fills those groups. Headings stay on the writer-kind card that
 * claimed them.
 *
 * `yours` is true when the current writer committed any proposal of that
 * writer kind touching the document in the window — participation, not
 * last-writer. That is the only durable, time-windowed, user-attributed
 * signal the home page already has (`ActivityItem.writer_id` vs
 * `currentUser.id`). Views (`ks_recent_docs`) have no timestamps and are
 * device-local; live `document:activity` presence is current-session only;
 * drafts and per-section git last-editor are not on this feed.
 */
export function buildRecentDocuments(
  activity: ActivityItem[],
  currentWriterId: string | null,
  nowMs: number = Date.now(),
  windowDays: number = HOME_RECENT_WINDOW_DAYS,
): HomeRecentDocument[] {
  const byDocKind = new Map<
    string,
    {
      docPath: string;
      writerKind: WriterType;
      timestamp: string;
      writerName: string;
      writerId: string;
      yours: boolean;
      headings: string[];
    }
  >();

  const sorted = [...activity].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  for (const item of sorted) {
    if (!activityItemInWindow(item, windowStartMs, nowMs)) continue;
    const isYours = currentWriterId != null && item.writer_id === currentWriterId;
    for (const section of item.sections) {
      const label = sectionLabel(section.heading_path);
      const key = `${section.doc_path}\0${item.writer_type}`;
      let row = byDocKind.get(key);
      if (!row) {
        row = {
          docPath: section.doc_path,
          writerKind: item.writer_type,
          timestamp: item.timestamp,
          writerName: item.writer_display_name,
          writerId: item.writer_id,
          yours: isYours,
          headings: [],
        };
        byDocKind.set(key, row);
      } else if (isYours) {
        row.yours = true;
      }
      if (label && !row.headings.includes(label)) row.headings.push(label);
    }
  }

  const docs: HomeRecentDocument[] = [];
  for (const row of byDocKind.values()) {
    const parsed = DocPath.tryParse(row.docPath);
    docs.push({
      docPath: row.docPath,
      title: parsed ? getDocDisplayName(parsed) : row.docPath,
      folderPrefix: folderPrefixOfDoc(row.docPath),
      writerName: row.writerName,
      writerId: row.writerId,
      writerKind: row.writerKind,
      timestamp: row.timestamp,
      yours: row.yours,
      changes: row.headings.length > 0 ? [{ kind: "rewritten", headings: row.headings }] : [],
    });
  }

  docs.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return docs;
}

/** Partition newest-first recent docs into current-writer vs everyone else. */
export function partitionRecentDocuments(documents: HomeRecentDocument[]): {
  yours: HomeRecentDocument[];
  others: HomeRecentDocument[];
} {
  const yours: HomeRecentDocument[] = [];
  const others: HomeRecentDocument[] = [];
  for (const doc of documents) {
    if (doc.yours) yours.push(doc);
    else others.push(doc);
  }
  return { yours, others };
}

export function countRecentDocuments(
  activity: ActivityItem[],
  nowMs: number = Date.now(),
  windowDays: number = HOME_RECENT_WINDOW_DAYS,
): number {
  const rows = new Set<string>();
  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  for (const item of activity) {
    if (!activityItemInWindow(item, windowStartMs, nowMs)) continue;
    for (const section of item.sections) rows.add(`${section.doc_path}\0${item.writer_type}`);
  }
  return rows.size;
}
