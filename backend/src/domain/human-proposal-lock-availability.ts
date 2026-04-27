import type {
  EvaluatedSection,
  ProposalHumanInvolvementEvaluation,
  ProposalSection,
} from "../types/shared.js";
import { SectionPresence } from "./section-presence.js";
import { SectionRef } from "./section-ref.js";

/**
 * Evaluate human proposal section availability against the lock-acquisition contract.
 *
 * This intentionally does NOT run human-involvement or aggregate-impact scoring.
 * It only reflects conditions that can block draft -> inprogress lock acquisition:
 * - active live edit
 * - uncommitted live edits
 * - another human inprogress lock
 */
export async function evaluateHumanProposalLockAvailability(
  proposalId: string,
  sections: ProposalSection[],
): Promise<{ evaluation: ProposalHumanInvolvementEvaluation; sections: EvaluatedSection[] }> {
  const docPaths = [...new Set(sections.map((section) => section.doc_path))];
  const dirtyFileSets = new Map<string, Set<string>>();
  for (const docPath of docPaths) {
    dirtyFileSets.set(docPath, await SectionPresence.prefetchDirtyFiles(docPath));
  }
  const inProgressLocks = await SectionPresence.prefetchHumanProposalLocks(
    proposalId,
    "inprogress-only",
  );

  const evaluatedSections: EvaluatedSection[] = sections.map((section) => {
    const ref = new SectionRef(section.doc_path, section.heading_path);
    const presenceConflict = SectionPresence.explainWithCache(
      ref,
      dirtyFileSets.get(section.doc_path) ?? new Set<string>(),
      inProgressLocks,
    );
    return {
      doc_path: section.doc_path,
      heading_path: section.heading_path,
      humanInvolvement_score: presenceConflict ? 1 : 0,
      blocked: !!presenceConflict,
      blocked_reason: presenceConflict ?? undefined,
      justification: section.justification,
    };
  });

  return {
    evaluation: {
      all_sections_accepted: evaluatedSections.every((section) => !section.blocked),
      aggregate_impact: 0,
      aggregate_threshold: 0,
      blocked_sections: evaluatedSections.filter((section) => section.blocked),
      passed_sections: evaluatedSections.filter((section) => !section.blocked),
    },
    sections: evaluatedSections,
  };
}
