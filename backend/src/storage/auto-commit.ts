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
import { getAllSessions, lookupDocSession, normalizeFragmentKeys, type DocSession } from "../crdt/ydoc-lifecycle.js";

import {
  importSessionDirtyFragmentsToOverlay,
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

/**
 * Return the subset of a writer's dirty fragment keys that fall within the
 * supplied headingPaths scope. When headingPaths is undefined/empty, returns
 * the writer's full dirty key set (a publish without a scope still operates
 * only on what THAT writer dirtied — never the union of all writers).
 */
function matchingDirtyFragmentKeys(
  session: DocSession,
  writerId: string,
  headingPaths?: string[][],
): Set<string> {
  const dirtyFragments = session.perUserDirty.get(writerId);
  if (!dirtyFragments || dirtyFragments.size === 0) {
    return new Set();
  }
  if (!headingPaths || headingPaths.length === 0) {
    return new Set(dirtyFragments);
  }

  const matched = new Set<string>();
  for (const headingPath of headingPaths) {
    const fragmentKey = session.fragments.findFragmentKeyForHeadingPath(headingPath);
    if (fragmentKey && dirtyFragments.has(fragmentKey)) {
      matched.add(fragmentKey);
    }
  }
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
    return matchingDirtyFragmentKeys(session, writer.id, headingPaths).size > 0;
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

  // Capture the publishing writer's scoped dirty fragment keys per session BEFORE
  // flush+normalize. Two reasons to snapshot before normalization:
  //  1. Normalization mutates dirty key sets (it can add new dirty keys for split
  //     fragments and remove keys for collapsed ones). The "what to clear after
  //     commit" set must reflect what THIS writer originally asked to publish.
  //  2. Normalization can restructure the skeleton, so we also snapshot each
  //     captured key's current heading path here for downstream `dirty:changed`
  //     events. The path is meaningful even if the fragment key disappears later.
  //
  // Bug D: post-commit cleanup must only clear the publishing writer's dirty
  // entries — never another writer's unrelated dirty state in the same session.
  const publisherScopePerSession = new Map<DocSession, {
    keys: Set<string>;
    keyToHeadingPath: Map<string, string[]>;
  }>();

  // Flush first, then normalize ONLY this writer's dirty fragments (scoped if
  // headingPaths supplied) against the live Y.Doc before committing from
  // sessions/docs/. Normalizing every fragment would touch sections this
  // writer never edited and can corrupt unrelated content (Bug A).
  for (const session of [...sessions.values()]) {
    if (!session.holders.has(writer.id)) continue;
    if (!docPathsToCommit.has(session.docPath)) continue;
    const matched = matchingDirtyFragmentKeys(session, writer.id, headingPaths);
    const keyToHeadingPath = new Map<string, string[]>();
    for (const fragmentKey of matched) {
      const resolvedHeadingPath = session.fragments.findHeadingPathForFragmentKey(fragmentKey);
      if (resolvedHeadingPath) {
        keyToHeadingPath.set(fragmentKey, [...resolvedHeadingPath]);
      }
    }
    publisherScopePerSession.set(session, { keys: matched, keyToHeadingPath });

    await importSessionDirtyFragmentsToOverlay(session, { fragmentKeys: matched });
    await normalizeFragmentKeys(session, matched);
  }

  const sectionsPublished: SectionTargetRef[] = [];
  let commitSha: string | undefined;
  const docEvents: Array<{
    docPath: string;
    commitSha: string;
    sections: SectionTargetRef[];
    contributorIds: string[];
    publisherClearedHeadingPaths: string[][];
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

      // Per-doc dedup of cleared heading paths so a writer holding multiple
      // sessions for the same doc only emits one dirty:changed event per path.
      const seenClearedPaths = new Set<string>();
      const publisherClearedHeadingPaths: string[][] = [];

      for (const session of docSessions) {
        const scope = publisherScopePerSession.get(session);
        if (scope) {
          const writerDirty = session.perUserDirty.get(writer.id);
          for (const fk of scope.keys) {
            if (writerDirty?.has(fk)) {
              writerDirty.delete(fk);
            }
            // Activity timestamps are session-wide (not per-writer). Only
            // delete them if no other writer still holds this fragment dirty.
            let stillDirtyByOther = false;
            for (const [otherWriterId, otherDirty] of session.perUserDirty) {
              if (otherWriterId === writer.id) continue;
              if (otherDirty.has(fk)) { stillDirtyByOther = true; break; }
            }
            if (!stillDirtyByOther) {
              session.fragmentFirstActivity.delete(fk);
              session.fragmentLastActivity.delete(fk);
            }
          }
          for (const [, headingPath] of scope.keyToHeadingPath) {
            const dedupKey = headingPath.join(">>");
            if (seenClearedPaths.has(dedupKey)) continue;
            seenClearedPaths.add(dedupKey);
            publisherClearedHeadingPaths.push(headingPath);
          }
        }
        // baseHead update is global and correct regardless of writer scope.
        session.baseHead = result.commitSha;
      }

      docEvents.push({
        docPath: dp,
        commitSha: result.commitSha,
        sections: result.committedSections,
        contributorIds: contributors.map((contributor) => contributor.id),
        publisherClearedHeadingPaths,
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

      // Bug D: dirty:changed events are scoped to the publishing writer × the
      // heading paths the writer actually published. We never emit these for
      // other writers (their dirty state was not touched).
      for (const headingPath of event.publisherClearedHeadingPaths) {
        onWsEvent({
          type: "dirty:changed",
          writer_id: writer.id,
          doc_path: event.docPath,
          heading_path: headingPath,
          dirty: false,
          base_head: null,
          committed_head: event.commitSha,
        });
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
export async function preemptiveImportNormalizeAndCommit(
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
    for (const fragmentKey of dirtySet) {
      const headingPath = session.fragments.findHeadingPathForFragmentKey(fragmentKey);
      if (headingPath) {
        dirtyHeadingPaths.push([...headingPath]);
      }
    }
    affectedWriters.push({ writerId, dirtyHeadingPaths });
  }

  // Normalise all dirty fragments (snapshot Set before iterating — normalisation adds new keys).
  const dirtySnapshot = new Set(session.fragments.dirtyKeys);
  for (const key of dirtySnapshot) {
    await session.fragments.normalizeStructure(key);
  }

  // Flush the normalised content to disk.
  await importSessionDirtyFragmentsToOverlay(session);

  // Commit session files to canonical. Use contributors for correct git attribution.
  const result = await commitSessionFilesToCanonical(
    Array.from(session.contributors.values()),
    docPath,
  );
  if (result.sectionsCommitted === 0 || !result.commitSha) {
    throw new Error(
      `preemptiveImportNormalizeAndCommit: commit for "${docPath}" produced no result ` +
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
    await importSessionDirtyFragmentsToOverlay(session);
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
