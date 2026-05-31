import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  checkProposalLocks,
  assertProposalLocksAvailable,
  ProposalLockConflictError,
} from "../../domain/proposal-fsm-locks.js";
import {
  createProposal,
  transitionToInProgress,
} from "../../storage/proposal-repository.js";
import type { WriterIdentity } from "../../types/shared.js";

/**
 * Replaces the legacy SectionGuard/SectionPresence/human-proposal-lock
 * "involvement" tests. Section human-involvement *scoring* moved to Area G's
 * agent-write-policy. The only contention primitive Area F owns is the proposal
 * FSM lock: a section is "blocked" iff another proposal holds an exclusive claim
 * (inprogress/committing) on it. There are NO dirty-file / live-focus /
 * git-recency / decay inputs.
 */

const DOC = "doc.md";
const HUMAN_A: WriterIdentity = { type: "human", id: "human-a", displayName: "Alice" };
const HUMAN_B: WriterIdentity = { type: "human", id: "human-b", displayName: "Bob" };

describe("proposal lock contention (replaces section-involvement)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("section with no holding proposal is available (no conflict)", async () => {
    const { id } = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["SomeSection"] },
    ]);
    const result = await checkProposalLocks({
      proposalId: id,
      targets: [{ doc_path: DOC, heading_path: ["SomeSection"] }],
    });
    expect(result.acquired).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("section held by another inprogress proposal is a conflict with prose message", async () => {
    const holder = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["Locked"] },
    ]);
    await transitionToInProgress(holder.id);

    const challenger = await createProposal(HUMAN_B, "edit", [
      { doc_path: DOC, heading_path: ["Locked"] },
    ]);
    const result = await checkProposalLocks({
      proposalId: challenger.id,
      targets: [{ doc_path: DOC, heading_path: ["Locked"] }],
    });

    expect(result.acquired).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].blockingProposalId).toBe(holder.id);
    expect(result.conflicts[0].message).toContain("Alice");
  });

  it("nested heading paths are matched exactly for conflicts", async () => {
    const holder = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["Parent", "Child"] },
    ]);
    await transitionToInProgress(holder.id);

    const challenger = await createProposal(HUMAN_B, "edit", [
      { doc_path: DOC, heading_path: ["Parent", "Child"] },
      { doc_path: DOC, heading_path: ["Parent"] },
    ]);
    const result = await checkProposalLocks({
      proposalId: challenger.id,
      targets: [
        { doc_path: DOC, heading_path: ["Parent", "Child"] },
        { doc_path: DOC, heading_path: ["Parent"] },
      ],
    });

    expect(result.acquired).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].target.heading_path).toEqual(["Parent", "Child"]);
  });

  it("assertProposalLocksAvailable throws on conflict", async () => {
    const holder = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["Locked"] },
    ]);
    await transitionToInProgress(holder.id);
    const challenger = await createProposal(HUMAN_B, "edit", [
      { doc_path: DOC, heading_path: ["Locked"] },
    ]);
    await expect(
      assertProposalLocksAvailable({
        proposalId: challenger.id,
        targets: [{ doc_path: DOC, heading_path: ["Locked"] }],
      }),
    ).rejects.toBeInstanceOf(ProposalLockConflictError);
  });
});
