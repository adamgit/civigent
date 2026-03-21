/**
 * SectionGuard — Central evaluation: "Can this agent write to this section?"
 *
 * Consolidates the full evaluation pipeline:
 *   1. SectionPresence check (live session / dirty files / human proposal)
 *   2. Graduated edit activity (pulse-based scoring)
 *   3. Recency-based human-involvement score
 *   4. Aggregate impact check (batch mode)
 *
 * Two entry points:
 *   - evaluate()      — single section, async (full I/O)
 *   - evaluateBatch()  — multiple sections, pre-fetches all I/O upfront
 */

import type {
  EvaluatedSection,
  ProposalHumanInvolvementEvaluation,
} from "../types/shared.js";

/** Per-section verdict from SectionGuard evaluation. */
export type SectionVerdict = EvaluatedSection;

/** Batch verdict from SectionGuard.evaluateBatch(). */
export type BatchVerdict = ProposalHumanInvolvementEvaluation;
import {
  evaluateSectionHumanInvolvement,
  computeAggregateImpact,
  AGGREGATE_IMPACT_THRESHOLD,
} from "./humanInvolvement.js";
import { SectionPresence, type HumanProposalLockIndex } from "./section-presence.js";
import { SectionRef } from "./section-ref.js";
import { SectionRecency } from "./section-recency.js";
import { readDocSectionCommitInfo, getSecondsSinceLastHumanActivity, type SectionCommitInfo } from "../storage/section-activity.js";

// ─── Input types ────────────────────────────────────────────────

export interface SectionInput {
  doc_path: string;
  heading_path: string[];
  justification?: string;
}

export interface BatchResult {
  evaluation: BatchVerdict;
  sections: SectionVerdict[];
}

// ─── SectionGuard ───────────────────────────────────────────────

export class SectionGuard {

  /**
   * Evaluate a single section. Full async I/O.
   * Used by single-section endpoints (heatmap per-section, read-section).
   */
  static async evaluate(
    ref: SectionRef,
    commitInfoMap: Map<string, SectionCommitInfo>,
  ): Promise<SectionVerdict> {
    const present = await SectionPresence.check(ref);

    // Hard block: live session, dirty files, or human proposal — short-circuit to score=1.0
    if (present) {
      return {
        doc_path: ref.docPath,
        heading_path: ref.headingPath,
        humanInvolvement_score: 1.0,
        blocked: true,
      };
    }

    // Soft block path: no active session, use commit-based recency
    const secondsSince = await getSecondsSinceLastHumanActivity(ref, commitInfoMap);

    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: secondsSince,
      hasJustification: false,
    });

    return {
      doc_path: ref.docPath,
      heading_path: ref.headingPath,
      humanInvolvement_score: result.score,
      blocked: result.blocked,
    };
  }

  /**
   * Evaluate a batch of sections (typically from a proposal).
   * Pre-fetches all I/O upfront (git info, dirty files, proposal locks),
   * then evaluates each section synchronously.
   * Includes aggregate impact check.
   */
  static async evaluateBatch(
    sections: SectionInput[],
    excludeProposalId?: string,
  ): Promise<BatchResult> {
    // Group by document for batched I/O
    const sectionsByDoc = new Map<string, SectionInput[]>();
    for (const section of sections) {
      const group = sectionsByDoc.get(section.doc_path) ?? [];
      group.push(section);
      sectionsByDoc.set(section.doc_path, group);
    }

    // Batch-fetch per document (1 git call + 1 readdir per unique doc)
    const commitInfoByDoc = new Map<string, Map<string, SectionCommitInfo>>();
    const dirtyFilesByDoc = new Map<string, Set<string>>();
    for (const [docPath, docSections] of sectionsByDoc) {
      const [info, dirtyFiles] = await Promise.all([
        readDocSectionCommitInfo(docPath, docSections.length),
        SectionPresence.prefetchDirtyFiles(docPath),
      ]);
      commitInfoByDoc.set(docPath, info);
      dirtyFilesByDoc.set(docPath, dirtyFiles);
    }

    // Pre-build human proposal lock index (single scan)
    const humanProposalLockIndex = await SectionPresence.prefetchHumanProposalLocks(excludeProposalId);

    // Evaluate each section
    const evaluatedSections: EvaluatedSection[] = [];
    for (const section of sections) {
      const dirtyFileSet = dirtyFilesByDoc.get(section.doc_path) ?? new Set<string>();
      const verdict = SectionGuard.evaluateWithPrefetch(
        section,
        dirtyFileSet,
        commitInfoByDoc.get(section.doc_path) ?? new Map(),
        humanProposalLockIndex,
      );
      evaluatedSections.push(verdict);
    }

    // Aggregate impact check
    const scores = evaluatedSections.map((s) => s.humanInvolvement_score);
    const aggregateResult = computeAggregateImpact(scores);

    const blockedSections = evaluatedSections.filter((s) => s.blocked);
    const passedSections = evaluatedSections.filter((s) => !s.blocked);

    let allAccepted = blockedSections.length === 0;
    if (allAccepted && aggregateResult.blocked) {
      allAccepted = false;
      // Mark highest-human-involvement section as blocked due to aggregate
      const sorted = [...passedSections].sort((a, b) => b.humanInvolvement_score - a.humanInvolvement_score);
      if (sorted.length > 0) {
        sorted[0].blocked = true;
      }
    }

    const evaluation: ProposalHumanInvolvementEvaluation = {
      all_sections_accepted: allAccepted,
      aggregate_impact: aggregateResult.aggregate,
      aggregate_threshold: AGGREGATE_IMPACT_THRESHOLD,
      blocked_sections: evaluatedSections.filter((s) => s.blocked),
      passed_sections: evaluatedSections.filter((s) => !s.blocked),
    };

    return { evaluation, sections: evaluatedSections };
  }

  /**
   * Evaluate a single section using pre-fetched caches. Sync (zero I/O).
   * Used internally by evaluateBatch().
   */
  static evaluateWithPrefetch(
    section: SectionInput,
    dirtyFileSet: Set<string>,
    commitByHeading: Map<string, SectionCommitInfo>,
    humanProposalLockIndex: HumanProposalLockIndex,
  ): SectionVerdict {
    const ref = new SectionRef(section.doc_path, section.heading_path);
    const present = SectionPresence.checkWithCache(
      ref,
      dirtyFileSet,
      humanProposalLockIndex,
    );

    // Hard block: live session, dirty files, or human proposal — short-circuit to score=1.0
    if (present) {
      return {
        doc_path: section.doc_path,
        heading_path: section.heading_path,
        humanInvolvement_score: 1.0,
        blocked: true,
        justification: section.justification,
      };
    }

    // Soft block path: no active session, use commit-based recency
    const secondsSince = SectionRecency.getSecondsSince(
      ref,
      dirtyFileSet,
      commitByHeading,
    );

    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity: secondsSince,
      hasJustification: !!section.justification,
    });

    return {
      doc_path: section.doc_path,
      heading_path: section.heading_path,
      humanInvolvement_score: result.score,
      blocked: result.blocked,
      justification: section.justification,
    };
  }
}
