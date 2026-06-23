/**
 * Proposal defect detector registry.
 *
 * A degraded proposal (one the decoder read leniently and tagged with a
 * {@link ProposalDefect}) is quarantined — it cannot acquire locks or commit
 * until repaired. This registry is the detect+autofix surface admins drive to
 * repair such proposals. Each entry knows how to (a) detect its defect on a
 * decoded proposal and (b) produce a repaired copy with the defect cleared.
 *
 * The list is built to extend: new detectors append a `{ id, label, detect, fix }`
 * entry. Today there is exactly one — `missing-targets` — which re-derives the
 * authoritative `targets` claim set from `sections` and clears the marker.
 */

import type { AnyProposal, ProposalDefect } from "../types/shared.js";
import { sectionsToTargets } from "../types/shared.js";

export interface ProposalDefectDetector {
  /** Stable id used as the `:detectorId` path segment of the autofix endpoint. */
  readonly id: string;
  /** Short human label for the admin surface (e.g. the autofix button). */
  readonly label: string;
  /** True when this proposal exhibits the defect this detector repairs. */
  detect(proposal: AnyProposal): boolean;
  /** Return a repaired copy of the proposal with this defect cleared. Pure — does
   *  not mutate the input or touch disk; the caller persists the result. */
  fix(proposal: AnyProposal): AnyProposal;
}

/** Drop a single defect from a proposal, returning a fresh proposal whose
 *  `degraded` marker is removed entirely when no defects remain. */
function clearDefect(proposal: AnyProposal, defect: ProposalDefect): AnyProposal {
  const remaining = (proposal.degraded ?? []).filter((d) => d !== defect);
  const fixed: AnyProposal = { ...proposal };
  if (remaining.length > 0) {
    fixed.degraded = remaining;
  } else {
    delete fixed.degraded;
  }
  return fixed;
}

export const PROPOSAL_DEFECT_DETECTORS: readonly ProposalDefectDetector[] = [
  {
    id: "missing-targets",
    label: "Missing targets",
    detect: (proposal) => (proposal.degraded ?? []).includes("missing-targets"),
    // Re-derive the section-claim targets from `sections` (the legacy file's only
    // possible claims) and clear the marker so the proposal can commit normally.
    fix: (proposal) => clearDefect({ ...proposal, targets: sectionsToTargets(proposal.sections) }, "missing-targets"),
  },
];

/** Look up a detector by its registry id, or `undefined` when none matches. */
export function findProposalDefectDetector(id: string): ProposalDefectDetector | undefined {
  return PROPOSAL_DEFECT_DETECTORS.find((detector) => detector.id === id);
}
