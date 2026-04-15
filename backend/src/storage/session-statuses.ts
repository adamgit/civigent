import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { AllSessionStatusesResponse } from "../types/shared.js";
import { getAllSessions } from "../crdt/ydoc-lifecycle.js";
import { getDataRoot, getSessionAuthorsRoot } from "./data-root.js";
import { getLatestCommitTimestampIso } from "./git-repo.js";

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

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

  try {
    const authorFiles = await readdir(getSessionAuthorsRoot());
    for (const fileName of authorFiles) {
      if (!fileName.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(getSessionAuthorsRoot(), fileName), "utf8");
        const parsed = JSON.parse(raw) as {
          dirtySections?: Array<{ docPath?: string; firstChangedAt?: string }>;
        };
        for (const section of parsed.dirtySections ?? []) {
          if (typeof section.docPath === "string" && section.docPath.length > 0) {
            outstandingDocs.add(section.docPath);
          }
          oldestOutstandingMs = updateOldest(
            oldestOutstandingMs,
            parseTimestampMs(section.firstChangedAt),
          );
        }
      } catch {
        // Ignore malformed or concurrently deleted author files; this endpoint is informational.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const lastCommitAt = await getLatestCommitTimestampIso(getDataRoot());

  return {
    live_session_count: liveSessions.length,
    outstanding_doc_count: outstandingDocs.size,
    oldest_outstanding_change_at:
      oldestOutstandingMs == null ? null : new Date(oldestOutstandingMs).toISOString(),
    last_commit_at: lastCommitAt,
  };
}
