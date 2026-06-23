/**
 * ProposalFsmLockIndex — batch index of proposal target claims.
 *
 * This is the efficient multi-target lookup backing `proposal-fsm-locks.ts`.
 * It indexes the claims held by proposals in a policy-supplied set of blocking
 * statuses (today: `inprogress` + `committing`), with self-exclusion by proposal
 * id, covering BOTH section targets and document targets (spec 12 §Data Shapes).
 *
 * Conflict semantics (spec 12 §Proposed Abstractions):
 *   - a section target conflicts with the same section target;
 *   - a document target conflicts with a document target for the same doc_path;
 *   - a document target conflicts with EVERY section target under that doc_path;
 *   - a section target conflicts with a document target for its doc_path.
 *
 * All doc-path comparisons are normalized via `normalizeDocPath` so a section
 * claim and a document claim on the same document always collide regardless of
 * leading-slash / casing conventions.
 *
 * Deliberately NOT carried over from the deleted heuristic modules: dirty-session
 * checks, live focus / editor-socket gating, soft-block reasons, and impact
 * scanning. All edits route through proposals, so a proposal claim is the only
 * lock primitive (spec 12 Non-Goals).
 */

import { SectionRef } from "./section-ref.js";
import { normalizeDocPath } from "../storage/path-utils.js";
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
 * Batch index of claims held by blocking-status proposals. Section claims are
 * keyed by `SectionRef.globalKey`; document claims by normalized doc_path. A
 * separate per-doc list of section holders answers the "document target conflicts
 * with any section under that doc" rule. First claim wins for a given key.
 */
export class ProposalFsmLockIndex {
  private readonly sectionHolders: Map<string, ProposalLockHolder>;
  private readonly documentHolders: Map<string, ProposalLockHolder>;
  private readonly sectionHoldersByDoc: Map<string, ProposalLockHolder>;

  private constructor(
    sectionHolders: Map<string, ProposalLockHolder>,
    documentHolders: Map<string, ProposalLockHolder>,
    sectionHoldersByDoc: Map<string, ProposalLockHolder>,
  ) {
    this.sectionHolders = sectionHolders;
    this.documentHolders = documentHolders;
    this.sectionHoldersByDoc = sectionHoldersByDoc;
  }

  /**
   * Build the index by scanning proposals in the requested blocking statuses.
   * Performs a single batched read; per-target lookups afterwards are zero-I/O.
   */
  static async build(options: BuildLockIndexOptions): Promise<ProposalFsmLockIndex> {
    const sectionHolders = new Map<string, ProposalLockHolder>();
    const documentHolders = new Map<string, ProposalLockHolder>();
    const sectionHoldersByDoc = new Map<string, ProposalLockHolder>();
    const proposals = await listProposalsByStatuses(options.statuses);

    for (const proposal of proposals) {
      if (options.excludeProposalId && proposal.id === options.excludeProposalId) continue;
      const holder: ProposalLockHolder = {
        blockingProposalId: proposal.id,
        blockingProposalStatus: proposal.status,
        blockingWriter: proposal.writer,
      };
      for (const target of proposal.targets) {
        if (target.kind === "document") {
          const key = normalizeDocPath(target.doc_path);
          if (!documentHolders.has(key)) documentHolders.set(key, holder);
        } else {
          const ref = SectionRef.fromTarget(target);
          if (!sectionHolders.has(ref.globalKey)) sectionHolders.set(ref.globalKey, holder);
          if (!sectionHoldersByDoc.has(ref.docPath)) sectionHoldersByDoc.set(ref.docPath, holder);
        }
      }
    }

    return new ProposalFsmLockIndex(sectionHolders, documentHolders, sectionHoldersByDoc);
  }

  /** Lookup the lock holder (if any) conflicting with a single target. */
  holderFor(target: ProposalTargetRef): ProposalLockHolder | null {
    if (target.kind === "document") {
      const doc = normalizeDocPath(target.doc_path);
      // A document target conflicts with a document claim on the same path, or
      // with any section claim under that document.
      return this.documentHolders.get(doc) ?? this.sectionHoldersByDoc.get(doc) ?? null;
    }
    const ref = SectionRef.fromTarget(target);
    // A section target conflicts with the same section claim, or with a document
    // claim covering its document.
    return this.sectionHolders.get(ref.globalKey) ?? this.documentHolders.get(ref.docPath) ?? null;
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
