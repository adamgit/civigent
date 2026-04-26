import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { AllSessionStatusesResponse } from "../types/shared.js";
import { getAllSessions } from "../crdt/ydoc-lifecycle.js";
import { getDataRoot, getSessionFragmentsRoot, getSessionSectionsContentRoot } from "./data-root.js";
import { getLatestCommitTimestampIso } from "./git-repo.js";
import { scanSessionFragmentDocPaths, scanSessionDocPaths } from "./session-scan.js";

function updateOldest(oldestMs: number | null, candidateMs: number | null): number | null {
  if (candidateMs == null) return oldestMs;
  if (oldestMs == null) return candidateMs;
  return Math.min(oldestMs, candidateMs);
}

export async function readAllSessionStatuses(): Promise<AllSessionStatusesResponse> {
  const outstandingDocs = new Set<string>();
  let oldestOutstandingMs: number | null = null;

  const liveSessions = [...getAllSessions().values()];
  for (const session of liveSessions) {
    let sessionHasDirty = false;
    for (const dirtyFragments of session.perUserDirty.values()) {
      if (dirtyFragments.size === 0) continue;
      sessionHasDirty = true;
      for (const fragmentKey of dirtyFragments) {
        oldestOutstandingMs = updateOldest(
          oldestOutstandingMs,
          session.fragmentFirstActivity.get(fragmentKey) ?? null,
        );
      }
    }
    if (sessionHasDirty) {
      outstandingDocs.add(session.docPath);
    }
  }

  const [persistedOverlayDocs, persistedFragmentDocs, oldestPersistedMs] = await Promise.all([
    scanSessionDocPaths(),
    scanSessionFragmentDocPaths(),
    collectOldestPersistedSessionMtimeMs(),
  ]);
  for (const docPath of persistedOverlayDocs) outstandingDocs.add(docPath);
  for (const docPath of persistedFragmentDocs) outstandingDocs.add(docPath);
  oldestOutstandingMs = updateOldest(oldestOutstandingMs, oldestPersistedMs);

  const lastCommitAt = await getLatestCommitTimestampIso(getDataRoot());

  return {
    live_session_count: liveSessions.length,
    outstanding_doc_count: outstandingDocs.size,
    oldest_outstanding_change_at:
      oldestOutstandingMs == null ? null : new Date(oldestOutstandingMs).toISOString(),
    last_commit_at: lastCommitAt,
  };
}

async function collectOldestPersistedSessionMtimeMs(): Promise<number | null> {
  const roots = [
    getSessionSectionsContentRoot(),
    getSessionFragmentsRoot(),
  ];
  let oldest: number | null = null;
  for (const root of roots) {
    oldest = updateOldest(oldest, await walkOldestSessionFileMtimeMs(root));
  }
  return oldest;
}

async function walkOldestSessionFileMtimeMs(dir: string): Promise<number | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let oldest: number | null = null;
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      oldest = updateOldest(oldest, await walkOldestSessionFileMtimeMs(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md") && !entry.name.endsWith(".writers.json")) continue;
    oldest = updateOldest(oldest, (await stat(fullPath)).mtimeMs);
  }
  return oldest;
}
