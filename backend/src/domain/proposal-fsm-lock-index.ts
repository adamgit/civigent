/**
 * ProposalFsmLockIndex — batch index of proposal section claims by target.
 *
 * This is the efficient multi-target lookup backing `proposal-fsm-locks.ts`.
 * It indexes the section claims held by proposals in a policy-supplied set of
 * blocking statuses (today: `inprogress` + `committing`) keyed by the globally
 * unique section target key, with self-exclusion by proposal id.
 *
 * Salvaged mechanics (and ONLY these) from the deleted `section-presence.ts`:
 *   - SectionRef target matching (reuses `domain/section-ref.ts`)
 *   - batched claim indexing across proposals
 *   - `excludeProposalId` self-exclusion
 *   - lock-holder metadata for conflict explanations
 *
 * Deliberately NOT carried over: dirty-session-file checks, live focus /
 * editor-socket gating, `active_live_edit`/`uncommitted_live_edits` reasons,
 * and `blockLevel: "all"` heuristic scanning. All edits now route through
 * proposals, so a proposal claim is the only lock primitive (spec 12 Non-Goals).
 */

import { SectionRef } from "./section-ref.js";
import { listProposalsByStatuses } from "../storage/proposal-repository.js";
import type {
  ProposalStatus,
  ProposalTargetRef,
  WriterIdentity,
} from "../types/shared.js";

/** Lock-holder metadata recorded for each claimed target. */
export interface ProposalLockHolder {
  blockingProposalId: string;
  blockingProposalStatus: ProposalStatus;
  blockingWriter: WriterIdentity;
}

export interface BuildLockIndexOptions {
  /** The set of proposal statuses whose claims are treated as exclusive locks. */
  statuses: readonly ProposalStatus[];
  /** Proposal id to exclude from the index (self-exclusion). */
  excludeProposalId?: string;
}

/**
 * Batch index of section claims held by blocking-status proposals, keyed by
 * `SectionRef.globalKey`. The first claim wins for a given target (proposals
 * holding exclusive locks should not overlap by construction).
 */
export class ProposalFsmLockIndex {
  private readonly holdersByGlobalKey: Map<string, ProposalLockHolder>;

  private constructor(holders: Map<string, ProposalLockHolder>) {
    this.holdersByGlobalKey = holders;
  }

  /**
   * Build the index by scanning proposals in the requested blocking statuses.
   * Performs a single batched read; per-target lookups afterwards are zero-I/O.
   */
  static async build(options: BuildLockIndexOptions): Promise<ProposalFsmLockIndex> {
    const holders = new Map<string, ProposalLockHolder>();
    const proposals = await listProposalsByStatuses(options.statuses);

    for (const proposal of proposals) {
      if (options.excludeProposalId && proposal.id === options.excludeProposalId) continue;
      for (const section of proposal.sections) {
        const key = SectionRef.fromTarget(section).globalKey;
        if (holders.has(key)) continue;
        holders.set(key, {
          blockingProposalId: proposal.id,
          blockingProposalStatus: proposal.status,
          blockingWriter: proposal.writer,
        });
      }
    }

    return new ProposalFsmLockIndex(holders);
  }

  /** Lookup the lock holder (if any) for a single target. */
  holderFor(target: ProposalTargetRef): ProposalLockHolder | null {
    const key = SectionRef.fromTarget(target).globalKey;
    return this.holdersByGlobalKey.get(key) ?? null;
  }

  /**
   * Return every target/holder pair where a claim conflicts. Reports ALL
   * conflicts (not first-failure) for batch transition checks.
   */
  conflictsFor(
    targets: readonly ProposalTargetRef[],
  ): Array<{ target: ProposalTargetRef; holder: ProposalLockHolder }> {
    const conflicts: Array<{ target: ProposalTargetRef; holder: ProposalLockHolder }> = [];
    for (const target of targets) {
      const holder = this.holderFor(target);
      if (holder) conflicts.push({ target, holder });
    }
    return conflicts;
  }
}
