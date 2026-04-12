/**
 * SectionRecency — "When was a human last here?"
 *
 * Consolidates the cascading timestamp lookup for human activity on a section:
 *   0. ACTIVITY_PULSE — most precise signal (human was actively typing)
 *   1. In-memory fragment activity — Y.Doc update timestamp
 *   2. Dirty session files on disk — section has uncommitted overlay content
 *   3. Git commit history — last time the section was committed
 *
 * Supports two modes:
 *   - Async: resolves heading path to file path for git lookup
 *   - Sync (bulk): uses pre-computed maps for zero I/O per section
 */

import { SectionRef } from "./section-ref.js";
import { lookupDocSession, getSectionEditPulse, findKeyForHeadingPath } from "../crdt/ydoc-lifecycle.js";
import type { SectionCommitInfo } from "../storage/section-activity.js";

export class SectionRecency {

  /**
   * Sync recency lookup using pre-computed maps. Zero I/O per call.
   *
   * @param dirtyFileSet - Set of SectionRef.headingKey() strings with dirty overlay files
   * @param commitByHeading - Map of headingKey → SectionCommitInfo from git
   * @returns seconds since last human activity, or null if no activity recorded
   */
  static getSecondsSince(
    ref: SectionRef,
    dirtyFileSet: Set<string>,
    commitByHeading: Map<string, SectionCommitInfo>,
  ): number | null {
    const now = Date.now();

    // 0. Highest priority: ACTIVITY_PULSE timestamp (most precise signal)
    const sectionPulse = getSectionEditPulse(ref);
    if (sectionPulse != null) {
      return Math.max(0, (now - sectionPulse) / 1000);
    }

    // 1. In-memory fragment activity (Y.Doc update timestamp)
    const session = lookupDocSession(ref.docPath);
    if (session) {
      const fk = findKeyForHeadingPath(session, ref.headingPath);
      if (fk) {
        const fragmentTime = session.fragmentLastActivity?.get(fk);
        if (fragmentTime != null) {
          return Math.max(0, (now - fragmentTime) / 1000);
        }
      }
    }

    // 2. Dirty session files on disk — treat as very recent
    if (dirtyFileSet.has(ref.key)) {
      return 0;
    }

    // 3. Git commit history (only human commits count)
    const commitInfo = commitByHeading.get(ref.key);
    if (commitInfo && commitInfo.writerType !== "agent") {
      return Math.max(0, (now - commitInfo.timestampMs) / 1000);
    }

    return null;
  }
}
