import type { WriterIdentity } from "../types/shared.js";
import { DocPath } from "../types/shared.js";

const HUMAN_DOCUMENT_ACTIVITY_RETENTION_MS = 60_000;

interface HumanDocumentActivityEntry {
  writer: WriterIdentity;
  lastAcceptedWriteAtMs: number | null;
  lastFinalEditorDetachAtMs: number | null;
}

export interface RecentHumanDocumentActivity {
  writer: WriterIdentity;
  lastWriteSecondsAgo?: number;
  lastEditorDetachSecondsAgo?: number;
}

const humanActivityByDocPath = new Map<string, Map<string, HumanDocumentActivityEntry>>();

function assertHumanWriter(writer: WriterIdentity): void {
  if (writer.type !== "human") {
    throw new Error(
      `human-document-activity only records human writers, got type "${writer.type}" for writer "${writer.id}"`,
    );
  }
}

function isEntryExpired(entry: HumanDocumentActivityEntry, nowMs: number): boolean {
  const newestMs = Math.max(entry.lastAcceptedWriteAtMs ?? 0, entry.lastFinalEditorDetachAtMs ?? 0);
  return nowMs - newestMs > HUMAN_DOCUMENT_ACTIVITY_RETENTION_MS;
}

function pruneExpiredEntries(docPath: DocPath, nowMs: number): Map<string, HumanDocumentActivityEntry> | undefined {
  const entries = humanActivityByDocPath.get(docPath);
  if (!entries) return undefined;
  for (const [writerId, entry] of entries) {
    if (isEntryExpired(entry, nowMs)) entries.delete(writerId);
  }
  if (entries.size === 0) {
    humanActivityByDocPath.delete(docPath);
    return undefined;
  }
  return entries;
}

function upsertEntry(docPath: DocPath, writer: WriterIdentity, nowMs: number): HumanDocumentActivityEntry {
  let entries = pruneExpiredEntries(docPath, nowMs);
  if (!entries) {
    entries = new Map<string, HumanDocumentActivityEntry>();
    humanActivityByDocPath.set(docPath, entries);
  }
  let entry = entries.get(writer.id);
  if (!entry) {
    entry = { writer, lastAcceptedWriteAtMs: null, lastFinalEditorDetachAtMs: null };
    entries.set(writer.id, entry);
  }
  entry.writer = writer;
  return entry;
}

export function recordAcceptedHumanDocumentWrite(docPath: DocPath, writer: WriterIdentity): void {
  assertHumanWriter(writer);
  const nowMs = Date.now();
  upsertEntry(docPath, writer, nowMs).lastAcceptedWriteAtMs = nowMs;
}

export function recordFinalHumanDocumentEditorDetach(docPath: DocPath, writer: WriterIdentity): void {
  assertHumanWriter(writer);
  const nowMs = Date.now();
  upsertEntry(docPath, writer, nowMs).lastFinalEditorDetachAtMs = nowMs;
}

export function readRecentHumanDocumentActivity(docPath: DocPath): RecentHumanDocumentActivity[] {
  const nowMs = Date.now();
  const entries = pruneExpiredEntries(docPath, nowMs);
  if (!entries) return [];
  const activity: RecentHumanDocumentActivity[] = [];
  for (const entry of entries.values()) {
    const row: RecentHumanDocumentActivity = { writer: entry.writer };
    if (entry.lastAcceptedWriteAtMs !== null) {
      row.lastWriteSecondsAgo = Math.max(0, Math.floor((nowMs - entry.lastAcceptedWriteAtMs) / 1000));
    }
    if (entry.lastFinalEditorDetachAtMs !== null) {
      row.lastEditorDetachSecondsAgo = Math.max(0, Math.floor((nowMs - entry.lastFinalEditorDetachAtMs) / 1000));
    }
    activity.push(row);
  }
  return activity;
}
