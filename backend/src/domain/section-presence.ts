/**
 * SectionPresence — editingPresence: server-authoritative edit detection.
 *
 * "Is a human editing here right now?" — drives agent blocking,
 * human-involvement scoring, and presence:editing / presence:done WS events.
 * Never derived from Y.js Awareness CRDT (that's viewingPresence, client-only).
 *
 * Consolidates the three-step active-edit detection:
 *   1. Live session: CRDT session with focus on this section (MSG_SECTION_FOCUS)
 *   2. Dirty files: Session overlay has uncommitted content for this section
 *   3. Human proposal: A pending human_reservation proposal locks this section
 *
 * Supports two modes:
 *   - Async (single section): full I/O checks, no pre-fetching needed
 *   - Sync (batch): uses pre-fetched caches for zero I/O per section
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { SectionRef } from "./section-ref.js";
import { lookupDocSession } from "../crdt/ydoc-lifecycle.js";
import { getSessionDocsRoot } from "../storage/data-root.js";
import { resolveHeadingPathUnderRoot } from "../storage/heading-resolver.js";
import { resolveAllSectionPaths } from "../storage/heading-resolver.js";
import { listProposals } from "../storage/proposal-repository.js";

// ─── Types ──────────────────────────────────────────────────────

export interface HumanProposalLockInfo {
  writerId: string;
  writerDisplayName: string;
}

export type HumanProposalLockIndex = Map<string, HumanProposalLockInfo>;

// ─── SectionPresence ────────────────────────────────────────────

export class SectionPresence {

  // ─── Async (single-section, full I/O) ───────────────────────

  /**
   * Full async check: is a human actively editing this section?
   * Performs disk I/O for dirty file check and proposal lookup.
   */
  static async check(ref: SectionRef): Promise<boolean> {
    // Step 1: Live session focus (hard block)
    if (SectionPresence.checkLiveSession(ref)) return true;

    // Step 2: Dirty session files on disk
    if (await SectionPresence.checkDirtyFile(ref)) return true;

    // Step 3: Human proposal lock
    const lock = await SectionPresence.checkHumanProposalLock(ref);
    return lock !== null;
  }

  // ─── Sync (batch, uses pre-fetched caches) ──────────────────

  /**
   * Sync check using pre-built caches. Zero I/O per call.
   * Use prefetchDirtyFiles() and prefetchHumanProposalLocks() first.
   */
  static checkWithCache(
    ref: SectionRef,
    dirtyFileSet: Set<string>,
    humanProposalLockIndex?: HumanProposalLockIndex,
  ): boolean {
    if (SectionPresence.checkLiveSession(ref)) return true;
    if (dirtyFileSet.has(ref.key)) return true;
    if (humanProposalLockIndex?.has(ref.globalKey)) return true;
    return false;
  }

  /**
   * Sync check: live session only (no disk I/O, no caches needed).
   * For contexts where only the CRDT session matters.
   */
  static checkLiveSessionOnly(ref: SectionRef): boolean {
    return SectionPresence.checkLiveSession(ref);
  }

  // ─── Batch pre-fetching ─────────────────────────────────────

  /**
   * Pre-fetch dirty session file set for a document.
   * Returns Set of SectionRef.headingKey() strings.
   */
  static async prefetchDirtyFiles(docPath: string): Promise<Set<string>> {
    const sessionDocsContentRoot = path.join(getSessionDocsRoot(), "content");
    const result = new Set<string>();

    let overlayPaths: Map<string, { absolutePath: string }>;
    try {
      overlayPaths = await resolveAllSectionPaths(sessionDocsContentRoot, docPath);
    } catch {
      return result;
    }

    const checks = [...overlayPaths.entries()].map(async ([key, resolved]) => {
      try {
        await access(resolved.absolutePath);
        result.add(key);
      } catch { /* file doesn't exist */ }
    });
    await Promise.all(checks);

    return result;
  }

  /**
   * Pre-fetch human proposal lock index across all pending proposals.
   * Returns Map keyed by SectionRef.globalKey.
   */
  static async prefetchHumanProposalLocks(
    excludeProposalId?: string,
  ): Promise<HumanProposalLockIndex> {
    const index: HumanProposalLockIndex = new Map();
    const pending = await listProposals("pending");
    for (const proposal of pending) {
      if (proposal.writer.type !== "human") continue;
      if (excludeProposalId && proposal.id === excludeProposalId) continue;
      for (const section of proposal.sections) {
        const key = SectionRef.fromTarget(section).globalKey;
        index.set(key, {
          writerId: proposal.writer.id,
          writerDisplayName: proposal.writer.displayName,
        });
      }
    }
    return index;
  }

  // ─── Internal checks ───────────────────────────────────────

  /**
   * Check if a live CRDT session has a writer focused on this section.
   * Per spec: focus within an active DocSession = fully contested (hard block).
   * No pulse check needed — pulse-based scoring is only for soft-block decay curves.
   */
  private static checkLiveSession(ref: SectionRef): boolean {
    const session = lookupDocSession(ref.docPath);
    if (!session || session.holders.size === 0) return false;

    for (const [, focusedPath] of session.sectionFocus.entries()) {
      if (ref.matchesHeadingPath(focusedPath)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a dirty session file exists on disk for this section.
   */
  private static async checkDirtyFile(ref: SectionRef): Promise<boolean> {
    const sessionDocsContentRoot = path.join(getSessionDocsRoot(), "content");
    try {
      const sectionPath = await resolveHeadingPathUnderRoot(
        sessionDocsContentRoot,
        ref.docPath,
        ref.headingPath,
      );
      await access(sectionPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a pending human_reservation proposal locks this section.
   */
  private static async checkHumanProposalLock(
    ref: SectionRef,
  ): Promise<HumanProposalLockInfo | null> {
    const pending = await listProposals("pending");
    for (const proposal of pending) {
      if (proposal.writer.type !== "human") continue;
      for (const section of proposal.sections) {
        if (
          section.doc_path === ref.docPath &&
          ref.matchesHeadingPath(section.heading_path)
        ) {
          return {
            writerId: proposal.writer.id,
            writerDisplayName: proposal.writer.displayName,
          };
        }
      }
    }
    return null;
  }
}
