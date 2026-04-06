/**
 * v4 Auto-Commit (Batch Commit from Session Files)
 *
 * Commit triggers:
 * 1. Disconnect (idle timeout 60s → disconnect → immediate commit)
 * 2. Human explicitly clicks "Publish Now"
 * 3. Server shutdown/restart
 *
 * There is NO periodic timer. Commits only happen on the above triggers.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { getAllSessions, lookupDocSession, normalizeAllFragments, type DocSession } from "../crdt/ydoc-lifecycle.js";
import { fragmentKeyFromSectionFile } from "../crdt/ydoc-fragments.js";

import {
  flushDocSessionToDisk,
  commitSessionFilesToCanonical,
  cleanupSessionFiles,
} from "./session-store.js";
import { getSessionAuthorsRoot } from "./data-root.js";
import type { WriterIdentity, WsServerEvent, SectionTargetRef } from "../types/shared.js";

export interface AutoCommitResult {
  committed: boolean;
  commitSha?: string;
  sectionsPublished: SectionTargetRef[];
}

let onWsEvent: ((event: WsServerEvent) => void) | null = null;

export function setAutoCommitEventHandler(handler: (event: WsServerEvent) => void): void {
  onWsEvent = handler;
}

function sameHeadingPath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function sessionHasMatchingDirtyScope(
  session: DocSession,
  writerId: string,
  headingPaths?: string[][],
): boolean {
  const dirtyFragments = session.perUserDirty.get(writerId);
  if (!dirtyFragments || dirtyFragments.size === 0) {
    return false;
  }
  if (!headingPaths || headingPaths.length === 0) {
    return true;
  }

  let matched = false;
  session.fragments.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
    if (matched) return;
    const isBeforeFirstHeading = level === 0 && heading === "";
    const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isBeforeFirstHeading);
    if (!dirtyFragments.has(fragmentKey)) return;
    if (headingPaths.some((target) => sameHeadingPath(target, headingPath))) {
      matched = true;
    }
  });
  return matched;
}

async function readWriterDirtySections(
  writerId: string,
): Promise<Array<{ docPath: string; headingPath: string[] }>> {
  const authorFile = path.join(getSessionAuthorsRoot(), `${writerId}.json`);
  try {
    const raw = await readFile(authorFile, "utf8");
    const data = JSON.parse(raw) as {
      writerId: string;
      dirtySections?: Array<{ docPath?: string; headingPath?: string[] }>;
    };
    if (!Array.isArray(data.dirtySections)) {
      return [];
    }
    return data.dirtySections
      .filter((entry) => typeof entry.docPath === "string")
      .map((entry) => ({
        docPath: entry.docPath!,
        headingPath: Array.isArray(entry.headingPath) ? entry.headingPath : [],
      }));
  } catch {
    return [];
  }
}

/**
 * Commit a writer's unpublished session content from canonical-ready session files.
 * Used by the "Publish Now" manual action while the session stays alive.
 */
export async function commitDirtySections(
  writer: WriterIdentity,
  docPath?: string,
  headingPaths?: string[][],
): Promise<AutoCommitResult> {
  const sessions = getAllSessions();
  const activeSessions = [...sessions.values()].filter((session) => {
    if (!session.holders.has(writer.id)) return false;
    if (docPath && session.docPath !== docPath) return false;
    return sessionHasMatchingDirtyScope(session, writer.id, headingPaths);
  });

  const docPathsToCommit = new Set<string>(activeSessions.map((session) => session.docPath));
  const diskDirtySections = await readWriterDirtySections(writer.id);
  for (const entry of diskDirtySections) {
    if (docPath && entry.docPath !== docPath) continue;
    if (headingPaths && headingPaths.length > 0 && !headingPaths.some((target) => sameHeadingPath(target, entry.headingPath))) {
      continue;
    }
    docPathsToCommit.add(entry.docPath);
  }

  if (docPathsToCommit.size === 0) {
    return { committed: false, sectionsPublished: [] };
  }

  // Flush first, then normalize against the live Y.Doc before committing from sessions/docs/.
  for (const session of [...sessions.values()]) {
    if (!session.holders.has(writer.id)) continue;
    if (!docPathsToCommit.has(session.docPath)) continue;
    await flushDocSessionToDisk(session);
    await normalizeAllFragments(session);
  }

  const sectionsPublished: SectionTargetRef[] = [];
  let commitSha: string | undefined;
  const docEvents: Array<{
    docPath: string;
    commitSha: string;
    sections: SectionTargetRef[];
    contributorIds: string[];
    writerIdsCleared: string[];
  }> = [];

  for (const dp of docPathsToCommit) {
    const docSessions = [...sessions.values()].filter((session) => session.docPath === dp);
    const contributors: WriterIdentity[] = [writer];
    const seenContributorIds = new Set([writer.id]);
    for (const session of docSessions) {
      for (const [contribId, contribIdentity] of session.contributors) {
        if (!seenContributorIds.has(contribId)) {
          seenContributorIds.add(contribId);
          contributors.push(contribIdentity);
        }
      }
    }
    const result = await commitSessionFilesToCanonical(contributors, dp);
    if (result.skeletonErrors.length > 0) {
      throw new Error(
        `commitDirtySections: commit skipped for ${dp}: ` +
        result.skeletonErrors.map((entry) => entry.error).join("\n"),
      );
    }
    if (result.sectionsCommitted > 0) {
      await cleanupSessionFiles(dp);
      if (!result.commitSha) {
        continue;
      }
      commitSha = result.commitSha;
      sectionsPublished.push(...result.committedSections);

      const writerIdsCleared = new Set<string>([writer.id]);
      for (const session of docSessions) {
        for (const [otherWriterId, dirtyFragments] of session.perUserDirty) {
          if (dirtyFragments.size > 0) {
            writerIdsCleared.add(otherWriterId);
          }
          for (const fk of dirtyFragments) {
            session.fragmentFirstActivity.delete(fk);
            session.fragmentLastActivity.delete(fk);
          }
          dirtyFragments.clear();
        }
        session.baseHead = result.commitSha;
      }

      docEvents.push({
        docPath: dp,
        commitSha: result.commitSha,
        sections: result.committedSections,
        contributorIds: contributors.map((contributor) => contributor.id),
        writerIdsCleared: [...writerIdsCleared],
      });
    }
  }

  if (!commitSha || sectionsPublished.length === 0) {
    return { committed: false, sectionsPublished: [] };
  }

  if (onWsEvent) {
    for (const event of docEvents) {
      onWsEvent({
        type: "content:committed",
        doc_path: event.docPath,
        sections: event.sections,
        commit_sha: event.commitSha,
        writer_id: writer.id,
        writer_display_name: writer.displayName,
        writer_type: writer.type,
        contributor_ids: event.contributorIds,
        seconds_ago: 0,
      });

      for (const writerId of event.writerIdsCleared) {
        for (const section of event.sections) {
          onWsEvent({
            type: "dirty:changed",
            writer_id: writerId,
            doc_path: section.doc_path,
            heading_path: section.heading_path,
            dirty: false,
            base_head: null,
            committed_head: event.commitSha,
          });
        }
      }
    }
  }

  return { committed: true, commitSha, sectionsPublished };
}

// ─── PreemptiveCommitResult ───────────────────────────────────────

export interface PreemptiveCommitResult {
  committedSha: string;
  affectedWriters: Array<{ writerId: string; dirtyHeadingPaths: string[][] }>;
}

/**
 * Flush, normalise, and commit a document's live session before a restore replaces
 * its canonical content.
 *
 * Returns null if no live session exists or if the session has no dirty content.
 * Throws if the commit does not produce a git commit SHA (restore must not proceed
 * with a failed pre-commit).
 *
 * Does NOT emit hub events — the caller (restore route + invalidateSessionForRestore)
 * delivers notifications via MSG_RESTORE_NOTIFICATION.
 */
export async function preemptiveFlushAndCommit(
  docPath: string,
): Promise<PreemptiveCommitResult | null> {
  const session = lookupDocSession(docPath);
  if (!session) return null;

  // No dirty content — nothing to commit.
  if (session.fragments.dirtyKeys.size === 0) return null;

  // Build affectedWriters BEFORE normalization alters the key set.
  const affectedWriters: Array<{ writerId: string; dirtyHeadingPaths: string[][] }> = [];
  for (const [writerId, dirtySet] of session.perUserDirty) {
    if (dirtySet.size === 0) continue;
    const dirtyHeadingPaths: string[][] = [];
    session.fragments.skeleton.forEachSection((heading, level, sectionFile, headingPath) => {
      const isBeforeFirstHeading = level === 0 && heading === "";
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isBeforeFirstHeading);
      if (dirtySet.has(fragmentKey)) {
        dirtyHeadingPaths.push([...headingPath]);
      }
    });
    affectedWriters.push({ writerId, dirtyHeadingPaths });
  }

  // Normalise all dirty fragments (snapshot Set before iterating — normalisation adds new keys).
  const dirtySnapshot = new Set(session.fragments.dirtyKeys);
  for (const key of dirtySnapshot) {
    await session.fragments.normalizeStructure(key);
  }

  // Flush the normalised content to disk.
  await flushDocSessionToDisk(session);

  // Commit session files to canonical. Use contributors for correct git attribution.
  const result = await commitSessionFilesToCanonical(
    Array.from(session.contributors.values()),
    docPath,
  );
  if (result.sectionsCommitted === 0 || !result.commitSha) {
    throw new Error(
      `preemptiveFlushAndCommit: commit for "${docPath}" produced no result ` +
      `(sectionsCommitted=${result.sectionsCommitted}, commitSha=${result.commitSha ?? "null"})`,
    );
  }

  // Remove session overlay so reconnecting clients load canonical (restored) content.
  await cleanupSessionFiles(docPath);

  return { committedSha: result.commitSha, affectedWriters };
}

/**
 * Commit all dirty sessions and orphaned disk files. Used at shutdown.
 *
 * First flushes all active Y.Docs to disk, then commits everything
 * from disk via commitSessionFilesToCanonical (which handles skeleton
 * promotion for heading renames).
 */
export async function commitAllDirtySessions(): Promise<void> {
  const sessions = getAllSessions();

  // Phase 1: Flush all active sessions to disk
  for (const [, session] of sessions) {
    await flushDocSessionToDisk(session);
  }

  // Phase 2: Commit all session files from disk (including just-flushed
  // active sessions and any previously orphaned files)
  const writer: WriterIdentity = {
    id: "system-shutdown",
    type: "human",
    displayName: "Shutdown Auto-Commit",
  };

  const result = await commitSessionFilesToCanonical([writer]);
  if (result.sectionsCommitted > 0) {
    await cleanupSessionFiles();
  }
}
