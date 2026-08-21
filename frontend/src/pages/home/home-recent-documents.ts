import type { ActivityItem, WriterType } from "../../types/shared.js";
import { HOME_RECENT_WINDOW_DAYS } from "./home-constants.js";
import { folderPrefixOfDoc } from "./home-tree-stats.js";
import { getDocDisplayName, headingText } from "../document-page-utils.js";
import { DocPath } from "../../types/shared.js";

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
  timestamp: string;
  yours: boolean;
  changes: HomeDocChangeGroup[];
}

function inWindow(iso: string, nowMs: number, days: number): boolean {
  return nowMs - Date.parse(iso) <= days * 24 * 60 * 60 * 1000;
}

function sectionLabel(headingPath: string[]): string | null {
  if (headingPath.length === 0) return null;
  const text = headingText(headingPath);
  return text.length > 0 ? text : null;
}

/**
 * One card per document touched in the window, newest first. Not sliced —
 * the home section paginates after partitioning so a wide Yours/Everyone-else
 * split can page each column independently.
 *
 * Activity items are committed proposals: they name the claimed heading paths
 * but do not record whether each path was a write, a create, or a move. Those
 * kinds are not persisted on the proposal manifest (create/write/move all
 * union into `sections`). Until a richer claim exists, every named heading is
 * shown as rewritten — the card still renders added/moved rows when a later
 * source fills those groups.
 *
 * `yours` is true when the current writer committed any proposal touching the
 * document in the window — participation, not last-writer. That is the only
 * durable, time-windowed, user-attributed signal the home page already has
 * (`ActivityItem.writer_id` vs `currentUser.id`). Views (`ks_recent_docs`)
 * have no timestamps and are device-local; live `document:activity` presence
 * is current-session only; drafts and per-section git last-editor are not on
 * this feed. A later collaborator or agent commit keeps the card in Yours
 * (the badge already meant that) and still names whoever wrote last.
 */
export function buildRecentDocuments(
  activity: ActivityItem[],
  currentWriterId: string | null,
  nowMs: number = Date.now(),
  windowDays: number = HOME_RECENT_WINDOW_DAYS,
  writerType?: WriterType,
): HomeRecentDocument[] {
  const byDoc = new Map<
    string,
    { timestamp: string; writerName: string; writerId: string; yours: boolean; headings: string[] }
  >();

  const sorted = [...activity].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  for (const item of sorted) {
    if (!inWindow(item.timestamp, nowMs, windowDays)) continue;
    if (writerType && item.writer_type !== writerType) continue;
    const isYours = currentWriterId != null && item.writer_id === currentWriterId;
    for (const section of item.sections) {
      const label = sectionLabel(section.heading_path);
      let row = byDoc.get(section.doc_path);
      if (!row) {
        row = {
          timestamp: item.timestamp,
          writerName: item.writer_display_name,
          writerId: item.writer_id,
          yours: isYours,
          headings: [],
        };
        byDoc.set(section.doc_path, row);
      } else {
        if (isYours) row.yours = true;
      }
      if (label && !row.headings.includes(label)) row.headings.push(label);
    }
  }

  const docs: HomeRecentDocument[] = [];
  for (const [docPath, row] of byDoc) {
    const parsed = DocPath.tryParse(docPath);
    docs.push({
      docPath,
      title: parsed ? getDocDisplayName(parsed) : docPath,
      folderPrefix: folderPrefixOfDoc(docPath),
      writerName: row.writerName,
      writerId: row.writerId,
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
  writerType?: WriterType,
): number {
  const docs = new Set<string>();
  for (const item of activity) {
    if (!inWindow(item.timestamp, nowMs, windowDays)) continue;
    if (writerType && item.writer_type !== writerType) continue;
    for (const section of item.sections) docs.add(section.doc_path);
  }
  return docs.size;
}
