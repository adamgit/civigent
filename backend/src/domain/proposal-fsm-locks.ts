/**
 * ProposalFsmLocks — the single core proposal/proposal exclusion module.
 *
 * Per spec 12 (Core Rule), proposal/proposal exclusion is enforced ONLY at FSM
 * transitions that require exclusive ownership. A proposal "holds a lock" on a
 * section target purely by being in a blocking status; there are no scores,
 * decay, presence, dirty-state, focus, or human-involvement inputs.
 *
 * Public API (resolved naming — see assumptions.md):
 *   - checkProposalLocks({ proposalId, targets }): Promise<ProposalLockResult>
 *   - assertProposalLocksAvailable({ proposalId, targets }): Promise<void>
 *
 * The blocking-status set is concrete FSM knowledge (internal const), not a
 * hot-swappable policy framework: `inprogress` + `committing` are the statuses
 * that hold exclusive claims today. spec 12's `ProposalTargetLockPolicy` is
 * realised here as that internal const.
 */

import { ProposalFsmLockIndex, type ProposalLockHolder } from "./proposal-fsm-lock-index.js";
import type {
  ProposalId,
  ProposalLockConflict,
  ProposalLockResult,
  ProposalTargetRef,
  ProposalStatus,
} from "../types/shared.js";

/**
 * Statuses that hold an exclusive claim on their section targets. This is the
 * internal blocking-status map (spec 12 `ProposalTargetLockPolicy`).
 */
export const BLOCKING_LOCK_STATUSES: readonly ProposalStatus[] = ["inprogress", "committing"];

export interface CheckProposalLocksInput {
  proposalId: ProposalId;
  targets: readonly ProposalTargetRef[];
}

function describeTarget(target: ProposalTargetRef): string {
  const heading = target.heading_path.length > 0
    ? target.heading_path.join(" > ")
    : "(document intro)";
  return `${target.doc_path} :: ${heading}`;
}

function conflictMessage(target: ProposalTargetRef, holder: ProposalLockHolder): string {
  const who = holder.blockingWriter.displayName || holder.blockingWriter.id;
  return (
    `"${describeTarget(target)}" is locked by ${who}'s ${holder.blockingProposalStatus} ` +
    `proposal. Wait for that proposal to finish (or be withdrawn), then retry.`
  );
}

function toConflict(target: ProposalTargetRef, holder: ProposalLockHolder): ProposalLockConflict {
  return {
    target,
    blockingProposalId: holder.blockingProposalId,
    blockingProposalStatus: holder.blockingProposalStatus,
    blockingWriter: holder.blockingWriter,
    message: conflictMessage(target, holder),
  };
}

/**
 * Check whether all of a proposal's targets are free of exclusive locks held
 * by OTHER proposals. Returns ALL conflicts (not first-failure), each carrying
 * blocking proposal id/status/writer and an action-oriented prose message,
 * plus a top-level prose message.
 *
 * Self-exclusion: the proposal's own claim never blocks itself.
 */
export async function checkProposalLocks(
  input: CheckProposalLocksInput,
): Promise<ProposalLockResult> {
  const index = await ProposalFsmLockIndex.build({
    statuses: BLOCKING_LOCK_STATUSES,
    excludeProposalId: input.proposalId,
  });

  const conflicts = index
    .conflictsFor(input.targets)
    .map(({ target, holder }) => toConflict(target, holder));

  if (conflicts.length === 0) {
    return {
      acquired: true,
      conflicts: [],
      message: "All targeted sections are available to lock.",
    };
  }

  const summary = conflicts.length === 1
    ? "1 targeted section is locked by another proposal."
    : `${conflicts.length} targeted sections are locked by other proposals.`;

  return {
    acquired: false,
    conflicts,
    message: `${summary} All-or-nothing: no locks were acquired.`,
  };
}

/**
 * Thrown when a transition that requires exclusive ownership is blocked by
 * conflicting proposal locks. Carries the full {@link ProposalLockResult} so
 * callers can surface structured conflicts + prose without re-running the check.
 */
export class ProposalLockConflictError extends Error {
  readonly result: ProposalLockResult;
  constructor(result: ProposalLockResult) {
    super(result.message);
    this.name = "ProposalLockConflictError";
    this.result = result;
  }
}

/**
 * Assert that all targets are lockable, throwing {@link ProposalLockConflictError}
 * on any conflict. Use at transitions that require exclusive ownership.
 */
export async function assertProposalLocksAvailable(
  input: CheckProposalLocksInput,
): Promise<void> {
  const result = await checkProposalLocks(input);
  if (!result.acquired) {
    throw new ProposalLockConflictError(result);
  }
}
