import type {
  ProposalLockConflict,
  ProposalSectionAvailabilityEntry,
  ProposalSectionAvailabilityEvent,
  ProposalSectionTargetRef,
} from "../types/shared.js";
import { asSectionTarget } from "../types/shared.js";
import {
  listDraftProposals,
  listInProgressProposals,
  readProposal,
} from "../storage/proposal-repository.js";
import { checkProposalLocks } from "../domain/proposal-fsm-locks.js";
import { SectionRef } from "../domain/section-ref.js";

function isHumanEditableProposalStatus(status: string): status is "draft" | "inprogress" {
  return status === "draft" || status === "inprogress";
}

/**
 * Build the proposal-lock-contention availability event for one human proposal,
 * scoped to a single document.
 *
 * Describes ONLY proposal FSM lock conflicts: per-section `available`, prose
 * `message`, and blocking proposal/writer metadata. It does NOT describe CRDT
 * editability, `section:blocked`/`section:gone`, publication pause, or agent
 * write-policy scoring (spec 12 §Event/API Surfaces). Lock detection routes
 * through `checkProposalLocks` (the only contention primitive); no dirty-session
 * or live-focus inputs are consulted.
 */
export async function buildProposalSectionAvailabilityEvent(
  proposalId: string,
  docPath: string,
): Promise<ProposalSectionAvailabilityEvent | null> {
  const proposal = await readProposal(proposalId);
  if (proposal.writer.type !== "human") return null;
  if (!isHumanEditableProposalStatus(proposal.status)) return null;

  const scopedSections = proposal.sections.filter((section) => section.doc_path === docPath);
  if (scopedSections.length === 0) return null;

  const lockResult = await checkProposalLocks({
    proposalId: proposal.id,
    targets: scopedSections.map((section) => asSectionTarget(section)),
  });

  // Conflicts are the queried section targets (this human proposal scopes only
  // sections); key each by its section global key for the per-section payload.
  const conflictByGlobalKey = new Map(
    lockResult.conflicts
      .filter(
        (conflict): conflict is ProposalLockConflict & { target: ProposalSectionTargetRef } =>
          conflict.target.kind === "section",
      )
      .map((conflict) => [
        new SectionRef(conflict.target.doc_path, conflict.target.heading_path).globalKey,
        conflict,
      ]),
  );

  const payloadSections: ProposalSectionAvailabilityEntry[] = scopedSections.map((section) => {
    const globalKey = new SectionRef(section.doc_path, section.heading_path).globalKey;
    const conflict = conflictByGlobalKey.get(globalKey);
    if (!conflict) {
      return {
        doc_path: section.doc_path,
        heading_path: section.heading_path,
        available: true,
      };
    }
    return {
      doc_path: section.doc_path,
      heading_path: section.heading_path,
      available: false,
      message: conflict.message,
      blocking_proposal_id: conflict.blockingProposalId,
      blocking_proposal_status: conflict.blockingProposalStatus,
      holder_writer_id: conflict.blockingWriter.id,
      holder_writer_display_name: conflict.blockingWriter.displayName,
    };
  });

  return {
    type: "proposal:section-availability",
    proposal_id: proposal.id,
    proposal_status: proposal.status,
    sections: payloadSections,
  };
}

export async function buildProposalSectionAvailabilityEventsForDoc(
  docPath: string,
): Promise<ProposalSectionAvailabilityEvent[]> {
  const candidates = [
    ...(await listDraftProposals()),
    ...(await listInProgressProposals()),
  ].filter((proposal) =>
    proposal.writer.type === "human"
    && isHumanEditableProposalStatus(proposal.status)
    && proposal.sections.some((section) => section.doc_path === docPath),
  );

  const events = await Promise.all(
    candidates.map(async (proposal) => buildProposalSectionAvailabilityEvent(proposal.id, docPath)),
  );
  return events.filter((event): event is ProposalSectionAvailabilityEvent => event !== null);
}
