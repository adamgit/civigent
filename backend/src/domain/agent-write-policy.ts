/**
 * Agent Write Policy (spec 12 §"Data Shapes"/"Transition Semantics"/
 * "Actor Behaviour"/"Implementation Notes").
 *
 * This module is the agent-only rule layer that sits *above* proposals. RBAC
 * answers whether a writer has document write permission; the Agent Write
 * Policy answers whether an *agent* proposal may proceed under the configured
 * human/agent collaboration rules.
 *
 * It is the single replacement boundary for every former
 * `SectionGuard.evaluateBatch()` / `evaluateProposalHumanInvolvement()` call
 * site. Per spec, this is NOT a hot-swap registry: exactly ONE policy is
 * selected at build time (module-level `AgentWritePolicy` below). Callers must
 * branch on `result.canWrite` (top-level and per-target) and render the policy's
 * prose `message`s — never bare reason codes or enums.
 *
 * Humans and human-authoritative operations BYPASS this policy entirely
 * (spec 12 §"Transition Semantics": "Human proposal publication does not call
 * Agent Write Policy"). The commit pipeline / routes / MCP tools are responsible
 * for not invoking it on the human path.
 *
 * The concrete policy shipped here is the **human-involvement compatibility
 * policy**: it preserves the legacy heuristic scoring math (now sourced from
 * `humanInvolvement.ts`, the only salvaged mechanic after `section-guard.ts` /
 * `section-presence.ts` / `section-recency.ts` were deleted in Area F) behind
 * the generic `AgentWritePolicyResult` contract so that `humanInvolvement_*`
 * vocabulary never leaks into core proposal/REST/MCP/frontend types.
 */

import {
  type ProposalId,
  type HumanInvolvementPolicyResult,
  type HumanInvolvementCommittedProposalMetadata,
  type ProposalSection,
  type SectionAgentWritePolicySummary,
} from "../types/shared.js";
import { SectionRef } from "./section-ref.js";
import {
  evaluateSectionHumanInvolvement,
  computeAggregateImpact,
  AGGREGATE_IMPACT_THRESHOLD,
} from "./humanInvolvement.js";
import {
  readDocSectionCommitInfo,
  secondsSinceLastCommit,
  type SectionCommitInfo,
} from "../storage/section-commit-history.js";
import { DocumentNotFoundError } from "../storage/content-layer.js";
import { HeadingNotFoundError } from "../storage/heading-resolver.js";
import { readActiveProposal } from "../storage/proposal-repository.js";
import { DocPath } from "../types/shared.js";

/**
 * The interface a single selected policy must implement. Generic over the
 * concrete policy result type so a future policy could be substituted at the
 * module-selection point without a registry.
 */
export interface AgentWritePolicyImpl<TResult> {
  /** Evaluate whether an agent proposal may write all of its targets. */
  evaluateProposal(proposalId: ProposalId): Promise<TResult>;
  /**
   * Derive the policy-specific committed metadata to persist at commit time.
   * Narrowly named (NOT a generic `commitRecord`) per spec 12.
   */
  buildCommittedProposalMetadata(result: TResult): HumanInvolvementCommittedProposalMetadata;
  /**
   * Section-level read-API summary (`canWrite` + selected-policy details).
   * Takes the pre-fetched per-document commit-info map from
   * `readDocSectionCommitInfo` (keyed by section-file path) so callers batch git
   * I/O once per document.
   */
  summarizeSection(
    ref: SectionRef,
    commitInfoByFilePath: Map<string, SectionCommitInfo>,
  ): Promise<SectionAgentWritePolicySummary>;
  /**
   * O(1) section-level summary derived from a PRE-RESOLVED per-section commit
   * info (the section's single most-recent canonical commit, or null when there
   * is no commit history). For bulk read surfaces (heatmap, section-list) that
   * have ALREADY resolved every section's file path and joined it to the git
   * batch map: they MUST use this instead of `summarizeSection`, which re-resolves
   * the heading (a full skeleton reparse) per call and is therefore quadratic
   * across a document.
   */
  summarizeSectionFromCommitInfo(
    ref: SectionRef,
    commitInfoForSection: SectionCommitInfo | null,
  ): SectionAgentWritePolicySummary;
}

// ─── Human-involvement compatibility policy ──────────────────────────

/**
 * Reconstructs the per-section soft-block evaluation that formerly lived in
 * `SectionGuard.evaluateBatch()`. The presence-based hard block (live session /
 * dirty files / human proposal lock) is intentionally NOT reproduced here — that
 * concern moved to `ProposalFsmLocks` (Area F). This policy is purely the
 * recency-driven human-involvement scoring plus the aggregate-impact escalation.
 */
class HumanInvolvementCompatibilityPolicy
  implements AgentWritePolicyImpl<HumanInvolvementPolicyResult>
{
  /**
   * Drop agent commits from a per-document commit-info map. Human-involvement
   * scoring counts only HUMAN activity (salvaged from the deleted
   * `SectionRecency.getSecondsSince`, which gated on `writerType !== "agent"`).
   * The commit-history `secondsSinceLastCommit` does NOT apply this filter, so
   * the policy applies it here to preserve the original scoring semantics —
   * otherwise an agent's own recent commit would block the next agent write.
   */
  private filterToHumanCommits(
    commitInfoByFilePath: Map<string, SectionCommitInfo>,
  ): Map<string, SectionCommitInfo> {
    const filtered = new Map<string, SectionCommitInfo>();
    for (const [key, info] of commitInfoByFilePath) {
      if (info.writerType !== "agent") filtered.set(key, info);
    }
    return filtered;
  }

  /**
   * Seconds since last human activity for a section, treating an unresolvable
   * section as "no recorded activity" (null → score 0). A proposal can target a
   * heading/document that does not yet exist in canonical (e.g. a brand-new
   * imported document materialized only in the proposal shadow); resolving such
   * a heading against canonical throws. That is not contention — it is simply
   * the absence of any human commit history to score against.
   */
  private async safeSecondsSinceLastHumanActivity(
    ref: SectionRef,
    commitInfoByFilePath: Map<string, SectionCommitInfo>,
  ): Promise<number | null> {
    try {
      return await secondsSinceLastCommit(ref, commitInfoByFilePath);
    } catch (err) {
      // FAIL LOUD (claim-review 04): score 0 ONLY for the legitimate "section not
      // yet in canonical" case (a brand-new doc/heading materialized only in the
      // proposal shadow). A skeleton-integrity error, I/O fault, or any other
      // failure is NOT "no history" — it is corruption/instability and MUST throw,
      // never coerce to null → 0. The catch is narrowed to the two not-yet-canonical
      // errors precisely so corruption is no longer absorbed here.
      if (err instanceof DocumentNotFoundError || err instanceof HeadingNotFoundError) {
        return null;
      }
      throw err;
    }
  }

  async evaluateProposal(proposalId: ProposalId): Promise<HumanInvolvementPolicyResult> {
    const proposal = await readActiveProposal(proposalId);
    return this.evaluateSections(proposal.sections);
  }

  /**
   * Batch-evaluate a proposal's sections. Pre-fetches git commit history once
   * per document (single streaming git process — never per section), then scores
   * each section and applies the aggregate-impact escalation.
   */
  private async evaluateSections(
    sections: ProposalSection[],
  ): Promise<HumanInvolvementPolicyResult> {
    // Group by document for batched I/O.
    const sectionsByDoc = new Map<string, ProposalSection[]>();
    for (const section of sections) {
      const group = sectionsByDoc.get(section.doc_path) ?? [];
      group.push(section);
      sectionsByDoc.set(section.doc_path, group);
    }

    // Per document: 1 git call. The resulting map is keyed by section-file path
    // relative to dataRoot — exactly what secondsSinceLastCommit()
    // (via lookupSectionCommitInfo → resolveHeadingPath) expects. Do NOT re-key
    // to heading keys here.
    const commitInfoByDoc = new Map<string, Map<string, SectionCommitInfo>>();
    for (const [docPath] of sectionsByDoc) {
      commitInfoByDoc.set(
        docPath,
        this.filterToHumanCommits(await readDocSectionCommitInfo(DocPath.parse(docPath))),
      );
    }

    // Score each section.
    const targets: HumanInvolvementPolicyResult["targets"] = [];
    for (const section of sections) {
      const ref = new SectionRef(section.doc_path, section.heading_path);
      const commitMap = commitInfoByDoc.get(section.doc_path) ?? new Map();
      const secondsSince = await this.safeSecondsSinceLastHumanActivity(ref, commitMap);
      const result = evaluateSectionHumanInvolvement({
        secondsSinceLastHumanActivity: secondsSince,
        hasJustification: !!section.justification,
      });

      targets.push({
        target: { kind: "section", doc_path: section.doc_path, heading_path: [...section.heading_path] },
        canWrite: !result.blocked,
        message: result.blocked
          ? this.blockedTargetMessage(ref, result.score, section.justification)
          : `Agents may write to ${ref.label}: recent human activity is low enough under the current human-involvement policy.`,
        details: {
          score: result.score,
          // The soft-block (score over threshold) carries no enumerated reason
          // in the new contract — the enumerated reasons are FSM-lock-owned
          // (`human_proposal_lock`) or aggregate-driven (`aggregate_impact`).
          blockedReason: null,
          justification: section.justification ?? null,
        },
      });
    }

    // Aggregate-impact escalation: even when every section individually passes,
    // a high combined human-involvement impact across the proposal trips a
    // top-level block on the single highest-scoring (currently passing) target.
    const scores = targets.map((t) => t.details.score);
    const aggregate = computeAggregateImpact(scores);

    let canWrite = targets.every((t) => t.canWrite);
    if (canWrite && aggregate.blocked) {
      canWrite = false;
      const passing = targets.filter((t) => t.canWrite);
      passing.sort((a, b) => b.details.score - a.details.score);
      const offending = passing[0];
      if (offending && offending.target.kind === "section") {
        offending.canWrite = false;
        offending.details.blockedReason = "aggregate_impact";
        offending.message =
          `Agents are blocked from writing to ${SectionRef.fromTarget(offending.target).label} ` +
          `because the proposal's combined recent-human-involvement impact ` +
          `(${aggregate.aggregate.toFixed(2)}) exceeds the allowed aggregate of ` +
          `${AGGREGATE_IMPACT_THRESHOLD}. Reduce the proposal's scope or wait for ` +
          `human activity to settle before retrying.`;
      }
    }

    return {
      canWrite,
      message: canWrite
        ? "Agent write policy: this proposal may publish."
        : "Agent write policy declined this proposal: one or more targets have too much recent human involvement. " +
          "Wait for human activity to settle, narrow the proposal's scope, or request a human to review.",
      targets,
      details: {
        aggregateImpact: aggregate.aggregate,
        aggregateThreshold: AGGREGATE_IMPACT_THRESHOLD,
      },
    };
  }

  private blockedTargetMessage(
    ref: SectionRef,
    score: number,
    justification?: string,
  ): string {
    const base =
      `Agents are blocked from writing to ${ref.label} because a human has been ` +
      `active there too recently (human-involvement score ${score.toFixed(2)}). ` +
      `Wait for the human's activity to settle and retry, or amend the proposal to ` +
      `drop this target.`;
    return justification
      ? base
      : `${base} Providing a justification may reduce the involvement score.`;
  }

  /**
   * Section-level read-API summary (spec 12 §Event/API Surfaces: "Document
   * section APIs should expose section-level agent write-policy summaries").
   *
   * Used by read paths (section-meta-builder, heatmap) that need a per-section
   * `canWrite` + selected-policy detail without constructing a proposal. Takes
   * the pre-fetched per-document commit-info map from `readDocSectionCommitInfo`
   * (keyed by section-file path relative to dataRoot) so callers keep batching
   * git I/O once per document — never per section.
   */
  async summarizeSection(
    ref: SectionRef,
    commitInfoByFilePath: Map<string, SectionCommitInfo>,
  ): Promise<SectionAgentWritePolicySummary> {
    const secondsSince = await this.safeSecondsSinceLastHumanActivity(
      ref,
      this.filterToHumanCommits(commitInfoByFilePath),
    );
    return this.buildSectionSummary(ref, secondsSince);
  }

  /**
   * O(1) counterpart of `summarizeSection` for callers that have already
   * resolved the section's most-recent commit (see interface doc). Human-
   * involvement scoring counts only HUMAN activity, so an agent's own most-recent
   * commit scores as "no human history" (null) — identical to the
   * `filterToHumanCommits` semantics of the map-based path, which likewise drops
   * a file whose most-recent commit was an agent.
   */
  summarizeSectionFromCommitInfo(
    ref: SectionRef,
    commitInfoForSection: SectionCommitInfo | null,
  ): SectionAgentWritePolicySummary {
    const secondsSince =
      commitInfoForSection && commitInfoForSection.writerType !== "agent"
        ? Math.max(0, (Date.now() - commitInfoForSection.timestampMs) / 1000)
        : null;
    return this.buildSectionSummary(ref, secondsSince);
  }

  private buildSectionSummary(
    ref: SectionRef,
    secondsSinceLastHumanActivity: number | null,
  ): SectionAgentWritePolicySummary {
    const result = evaluateSectionHumanInvolvement({
      secondsSinceLastHumanActivity,
      hasJustification: false,
    });
    return {
      canWrite: !result.blocked,
      message: result.blocked
        ? `Agents are currently blocked from writing to ${ref.label} because a human has ` +
          `been active there too recently (human-involvement score ${result.score.toFixed(2)}). ` +
          `Wait for the human's activity to settle before agents can write here again.`
        : `Agents can currently write to ${ref.label}: recent human activity is low enough ` +
          `under the current human-involvement policy.`,
      humanInvolvement: { score: result.score },
    };
  }

  buildCommittedProposalMetadata(
    result: HumanInvolvementPolicyResult,
  ): HumanInvolvementCommittedProposalMetadata {
    // Per-section score snapshot keyed by global section key — the same shape
    // callers used to hand-build from `humanInvolvement_score`.
    const snapshot: HumanInvolvementCommittedProposalMetadata = {};
    for (const target of result.targets) {
      // The HI policy only scores section targets; document targets (if ever
      // present) carry no synthetic score and are skipped (spec 12 §Data Shapes).
      if (target.target.kind !== "section") continue;
      const ref = SectionRef.fromTarget(target.target);
      snapshot[ref.globalKey] = target.details.score;
    }
    return snapshot;
  }
}

/**
 * A success-phrased policy result representing the human / human-authoritative
 * bypass (spec 12: "Human proposal publication does not call Agent Write
 * Policy"). Used where a DTO requires an `agentWritePolicy` field on a path that
 * never actually evaluates the policy, so humans are never shown as blocked.
 */
export function humanBypassPolicyResult(): HumanInvolvementPolicyResult {
  return {
    canWrite: true,
    message: "Human writers are not governed by the agent write policy.",
    targets: [],
    details: { aggregateImpact: 0, aggregateThreshold: AGGREGATE_IMPACT_THRESHOLD },
  };
}

/**
 * The single, module-level selected Agent Write Policy. Selection is a build
 * constant (the human-involvement compatibility policy), NOT a registry or
 * admin-config-driven hot swap (spec 12 §"Implementation Notes": "agent
 * proposals pass through one selected Agent Write Policy"). The policy's own
 * scoring math still reads admin config (`humanInvolvement_preset`) via
 * `humanInvolvement.ts`; only the *choice of policy* is fixed at build time.
 */
export const AgentWritePolicy: AgentWritePolicyImpl<HumanInvolvementPolicyResult> =
  new HumanInvolvementCompatibilityPolicy();
