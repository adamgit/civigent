import type {
  ProposalSectionAvailabilityEntry,
  ProposalSectionAvailabilityEvent,
} from "../types/shared.js";
import { evaluateHumanProposalLockAvailability } from "../domain/human-proposal-lock-availability.js";
import {
  listDraftProposals,
  listInProgressProposals,
  readProposal,
} from "../storage/proposal-repository.js";
import { SectionPresence } from "../domain/section-presence.js";
import { SectionRef } from "../domain/section-ref.js";

function isHumanEditableProposalStatus(status: string): status is "draft" | "inprogress" {
  return status === "draft" || status === "inprogress";
}

export async function buildProposalSectionAvailabilityEvent(
  proposalId: string,
  docPath: string,
): Promise<ProposalSectionAvailabilityEvent | null> {
  const proposal = await readProposal(proposalId);
  if (proposal.writer.type !== "human") return null;
  if (!isHumanEditableProposalStatus(proposal.status)) return null;

  const { sections } = await evaluateHumanProposalLockAvailability(proposal.id, proposal.sections);
  const scopedSections = sections.filter((section) => section.doc_path === docPath);
  if (scopedSections.length === 0) return null;

  const needsLockHolderLookup = scopedSections.some(
    (section) => section.blocked && section.blocked_reason === "human_proposal_lock",
  );
  const lockIndex = needsLockHolderLookup
    ? await SectionPresence.prefetchHumanProposalLocks(proposal.id, "inprogress-only")
    : null;

  const payloadSections: ProposalSectionAvailabilityEntry[] = scopedSections.map((section) => {
    const payload: ProposalSectionAvailabilityEntry = {
      doc_path: section.doc_path,
      heading_path: section.heading_path,
      available: !section.blocked,
      ...(section.blocked ? { blocked_reason: section.blocked_reason } : {}),
    };

    if (section.blocked_reason === "human_proposal_lock" && lockIndex) {
      const globalKey = new SectionRef(section.doc_path, section.heading_path).globalKey;
      const holder = lockIndex.get(globalKey);
      if (holder) {
        payload.holder_writer_id = holder.writerId;
        payload.holder_writer_display_name = holder.writerDisplayName;
      }
    }
    return payload;
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
