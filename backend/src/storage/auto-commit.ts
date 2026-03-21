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

import { getAllSessions, type DocSession } from "../crdt/ydoc-lifecycle.js";
import { FragmentStore } from "../crdt/fragment-store.js";
import { fragmentKeyFromSectionFile } from "../crdt/ydoc-fragments.js";

import {
  flushDocSessionToDisk,
  commitSessionFilesToCanonical,
  cleanupSessionFiles,
} from "./session-store.js";
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

/**
 * Commit dirty sections for a specific writer from active sessions.
 * Used by the "Publish Now" manual action (user is still connected).
 *
 * Uses forEachSection() visitor with stable fragment keys (section-file-ID-based)
 * so heading renames don't cause key mismatches.
 */
export async function commitDirtySections(
  writer: WriterIdentity,
  docPath?: string,
  headingPaths?: string[][],
): Promise<AutoCommitResult> {
  const sessions = getAllSessions();
  const sectionsToCommit: Array<{ doc_path: string; heading_path: string[]; content: string }> = [];
  for (const [, session] of sessions) {
    if (!session.holders.has(writer.id)) continue;
    if (docPath && session.docPath !== docPath) continue;

    const dirtyFragments = session.perUserDirty.get(writer.id);
    if (!dirtyFragments || dirtyFragments.size === 0) continue;

    // Flush session to disk first so the overlay skeleton is up to date
    await flushDocSessionToDisk(session);

    // Iterate skeleton entries — stable fragment keys mean no rename ambiguity
    session.fragments.skeleton.forEachSection((heading, level, sectionFile, headingPath, absolutePath) => {
      const isRoot = level === 0 && heading === "";
      const fragmentKey = fragmentKeyFromSectionFile(sectionFile, isRoot);
      if (!dirtyFragments.has(fragmentKey)) return;
      if (headingPaths && !headingPaths.some(
        (target) => JSON.stringify(target) === JSON.stringify(headingPath),
      )) return;

      const markdown = session.fragments.readBodyForDisk(fragmentKey);
      if (!markdown) return;

      sectionsToCommit.push({
        doc_path: session.docPath,
        heading_path: [...headingPath],
        content: markdown,
      });
    });
  }

  if (sectionsToCommit.length === 0) {
    return { committed: false, sectionsPublished: [] };
  }

  // Collect co-authors: other writers who have dirty fragments overlapping committed sections
  const committedFragmentKeys = new Set<string>();
  for (const section of sectionsToCommit) {
    for (const [, session] of sessions) {
      if (session.docPath !== section.doc_path) continue;
      try {
        const entry = session.fragments.skeleton.resolve(section.heading_path);
        committedFragmentKeys.add(FragmentStore.fragmentKeyFor(entry));
      } catch { /* section not in skeleton — skip */ }
    }
  }

  const coAuthors: Array<{ name: string; email: string }> = [];
  const seenCoAuthorIds = new Set<string>();
  for (const [, session] of sessions) {
    for (const [otherWriterId, dirtySet] of session.perUserDirty) {
      if (otherWriterId === writer.id) continue;
      if (seenCoAuthorIds.has(otherWriterId)) continue;
      // Check if any of this writer's dirty fragments overlap committed sections
      for (const fk of dirtySet) {
        if (committedFragmentKeys.has(fk)) {
          seenCoAuthorIds.add(otherWriterId);
          const identity = session.holders.get(otherWriterId);
          coAuthors.push({
            name: identity?.displayName ?? otherWriterId,
            email: identity?.email ?? `${otherWriterId}@knowledge-store.local`,
          });
          break;
        }
      }
    }
  }

  // Flush ensures disk is current. Commit from disk (handles skeleton promotion).
  let commitSha: string | undefined;
  for (const dp of new Set(sectionsToCommit.map((s) => s.doc_path))) {
    const result = await commitSessionFilesToCanonical(writer, dp, coAuthors);
    if (result.sectionsCommitted > 0) {
      await cleanupSessionFiles(dp);
      if (result.commitSha) {
        commitSha = result.commitSha;
      }
    }
  }

  if (!commitSha) {
    return { committed: false, sectionsPublished: [] };
  }

  // Clear dirty state for ALL writers' committed sections (not just publisher).
  // The CRDT merge means the committed content includes all writers' edits.
  const otherWriterCleared: Array<{ writerId: string; doc_path: string; heading_path: string[] }> = [];
  for (const [, session] of sessions) {
    for (const [otherWriterId, dirtyFragments] of session.perUserDirty) {
      for (const section of sectionsToCommit) {
        if (session.docPath === section.doc_path) {
          try {
            const entry = session.fragments.skeleton.resolve(section.heading_path);
            const fk = FragmentStore.fragmentKeyFor(entry);
            if (dirtyFragments.has(fk)) {
              dirtyFragments.delete(fk);
              if (otherWriterId !== writer.id) {
                otherWriterCleared.push({
                  writerId: otherWriterId,
                  doc_path: section.doc_path,
                  heading_path: section.heading_path,
                });
              }
            }
          } catch {
            // Heading path no longer resolves — section was renamed/restructured
            // during editing. The dirty entry stays (harmless stale reference).
          }
        }
      }
    }
    // Update baseHead
    if (sectionsToCommit.some((s) => s.doc_path === session.docPath)) {
      session.baseHead = commitSha;
    }
  }

  const sectionsPublished = sectionsToCommit.map((s) => ({
    doc_path: s.doc_path,
    heading_path: s.heading_path,
  }));

  if (onWsEvent) {
    onWsEvent({
      type: "content:committed",
      doc_path: sectionsToCommit[0].doc_path,
      sections: sectionsPublished,
      commit_sha: commitSha,
      source: "human_auto_commit",
      writer_id: writer.id,
      writer_display_name: writer.displayName,
    });

    for (const section of sectionsPublished) {
      onWsEvent({
        type: "dirty:changed",
        writer_id: writer.id,
        doc_path: section.doc_path,
        heading_path: section.heading_path,
        dirty: false,
        base_head: null,
        committed_head: commitSha,
      });
    }

    // Emit dirty:changed for other writers whose dirty state was cleared
    for (const cleared of otherWriterCleared) {
      onWsEvent({
        type: "dirty:changed",
        writer_id: cleared.writerId,
        doc_path: cleared.doc_path,
        heading_path: cleared.heading_path,
        dirty: false,
        base_head: null,
        committed_head: commitSha,
      });
    }
  }

  return { committed: true, commitSha, sectionsPublished };
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

  const result = await commitSessionFilesToCanonical(writer);
  if (result.sectionsCommitted > 0) {
    await cleanupSessionFiles();
  }
}
