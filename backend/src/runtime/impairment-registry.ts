import type { ImpairmentReport, ProposalId } from "../types/shared.js";
import { sectionTargetsOf } from "../types/shared.js";
import { readProposal, listInProgressProposals, isCrdtOwnedProposal } from "../storage/proposal-repository.js";
import { getAllSessions } from "../crdt/ydoc-lifecycle.js";

type ImpairmentRaiseDelivery = (report: ImpairmentReport) => void;
type ImpairmentClearDelivery = (proposalId: ProposalId) => void;

let deliverRaise: ImpairmentRaiseDelivery | null = null;
let deliverClear: ImpairmentClearDelivery | null = null;

const impairments = new Map<ProposalId, ImpairmentReport>();

export function setImpairmentDeliveryHandler(
  onRaise: ImpairmentRaiseDelivery,
  onClear?: ImpairmentClearDelivery,
): void {
  deliverRaise = onRaise;
  deliverClear = onClear ?? null;
}

export function raiseImpairment(report: ImpairmentReport): void {
  impairments.set(report.id, report);
  if (deliverRaise) {
    try {
      deliverRaise(report);
    } catch (err) {
      console.error("[impairment] raise delivery handler threw:", err);
    }
  }
}

export function clearImpairment(proposalId: ProposalId): void {
  if (!impairments.delete(proposalId)) return;
  if (deliverClear) {
    try {
      deliverClear(proposalId);
    } catch (err) {
      console.error("[impairment] clear delivery handler threw:", err);
    }
  }
}

export function getCurrentImpairments(): ImpairmentReport[] {
  return [...impairments.values()];
}

/**
 * Drop impairments whose proposal is no longer `inprogress` or `committing`.
 * A successful publish or withdraw that missed `clearImpairment` must not stay
 * sticky. Does not drop an id we cannot read — in-memory test raises have no
 * on-disk proposal.
 */
export async function pruneResolvedImpairments(): Promise<void> {
  for (const id of [...impairments.keys()]) {
    const proposal = await readProposal(id).catch(() => null);
    if (proposal && proposal.status !== "inprogress" && proposal.status !== "committing") {
      clearImpairment(id);
    }
  }
}

export async function raiseImpairmentForLeftoverProposal(proposalId: ProposalId, error: unknown): Promise<void> {
  const proposal = await readProposal(proposalId).catch(() => null);
  if (!proposal || proposal.status !== "inprogress") return;
  const err = error instanceof Error ? error : new Error(String(error));
  raiseImpairment({
    id: proposalId,
    message: err.message,
    stack: err.stack ?? "",
    cause: err.cause != null ? String(err.cause) : null,
    timestamp: new Date().toISOString(),
    doc_paths: [...new Set(proposal.targets.map((t) => t.doc_path))],
    targets: sectionTargetsOf(proposal.targets),
  });
}

export async function raiseImpairmentsForLeftoverInProgressProposals(): Promise<void> {
  const liveAdoptionIds = new Set(
    [...getAllSessions().values()].map((session) => String(session.generator.proposalAdoptionId)),
  );
  const proposals = await listInProgressProposals();
  for (const proposal of proposals) {
    if (!isCrdtOwnedProposal(proposal)) continue;
    if (proposal.proposalAdoptionId && liveAdoptionIds.has(String(proposal.proposalAdoptionId))) continue;
    raiseImpairment({
      id: proposal.id,
      message: `In-flight claims remain on proposal ${proposal.id}'s targets from a previous run.`,
      stack: "",
      cause: null,
      timestamp: new Date().toISOString(),
      doc_paths: [...new Set(proposal.targets.map((t) => t.doc_path))],
      targets: sectionTargetsOf(proposal.targets),
    });
  }
}

export function resetImpairmentRegistryForTests(): void {
  impairments.clear();
  deliverRaise = null;
  deliverClear = null;
}
