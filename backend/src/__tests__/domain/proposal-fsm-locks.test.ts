import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  checkProposalLocks,
  assertProposalLocksAvailable,
  ProposalLockConflictError,
  BLOCKING_LOCK_STATUSES,
} from "../../domain/proposal-fsm-locks.js";
import { ProposalFsmLockIndex } from "../../domain/proposal-fsm-lock-index.js";
import {
  createProposal,
  transitionToInProgress,
  transitionToCommitting,
  rollbackCommittingToInProgress,
  rollbackCommittingToDraft,
  rollbackCommittingProposal,
  readProposal,
} from "../../storage/proposal-repository.js";
import type { WriterIdentity, ProposalTargetRef } from "../../types/shared.js";
import { sectionTargetsOf } from "../../types/shared.js";

const DOC = "/doc.md";

const HUMAN_A: WriterIdentity = { type: "human", id: "human-a", displayName: "Alice" };
const HUMAN_B: WriterIdentity = { type: "human", id: "human-b", displayName: "Bob" };
const AGENT: WriterIdentity = { type: "agent", id: "agent-1", displayName: "Agent One" };

function target(headingPath: string[]): ProposalTargetRef {
  return { doc_path: DOC, heading_path: headingPath };
}

describe("proposal-fsm-locks / proposal-fsm-lock-index", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("blocking-status set is exactly inprogress + committing", () => {
    expect([...BLOCKING_LOCK_STATUSES].sort()).toEqual(["committing", "inprogress"]);
  });

  it("no conflicts when no other proposal holds the targets", async () => {
    const { id } = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    const result = await checkProposalLocks({ proposalId: id, targets: [target(["Overview"])] });
    expect(result.acquired).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("an inprogress proposal blocks another proposal's overlapping target with holder metadata", async () => {
    const holder = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    const acquired = await transitionToInProgress(holder.id);
    expect(acquired.acquired).toBe(true);

    const challenger = await createProposal(HUMAN_B, "edit", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    const result = await checkProposalLocks({
      proposalId: challenger.id,
      targets: [target(["Overview"])],
    });

    expect(result.acquired).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.target.heading_path).toEqual(["Overview"]);
    expect(conflict.blockingProposalId).toBe(holder.id);
    expect(conflict.blockingProposalStatus).toBe("inprogress");
    expect(conflict.blockingWriter.id).toBe(HUMAN_A.id);
    expect(conflict.blockingWriter.displayName).toBe("Alice");
    expect(conflict.message).toContain("Alice");
    expect(conflict.message.length).toBeGreaterThan(0);
  });

  it("a committing proposal also blocks (committing is an exclusive claim)", async () => {
    const holder = await createProposal(AGENT, "agent edit", [
      { doc_path: DOC, heading_path: ["Timeline"] },
    ]);
    // Agent proposal: draft -> committing directly.
    await transitionToCommitting(holder.id);

    const challenger = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["Timeline"] },
    ]);
    const result = await checkProposalLocks({
      proposalId: challenger.id,
      targets: [target(["Timeline"])],
    });

    expect(result.acquired).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].blockingProposalStatus).toBe("committing");
  });

  it("draft proposals never block (creation/draft editing is permissive)", async () => {
    // HUMAN_A keeps a draft on Overview (never transitions).
    await createProposal(HUMAN_A, "draft edit", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    const challenger = await createProposal(HUMAN_B, "edit", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    const result = await checkProposalLocks({
      proposalId: challenger.id,
      targets: [target(["Overview"])],
    });
    expect(result.acquired).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("reports ALL conflicts across multiple targets (not first-failure)", async () => {
    const holderA = await createProposal(HUMAN_A, "edit a", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    await transitionToInProgress(holderA.id);
    const holderB = await createProposal(HUMAN_B, "edit b", [
      { doc_path: DOC, heading_path: ["Timeline"] },
    ]);
    await transitionToInProgress(holderB.id);

    const challenger = await createProposal(
      { type: "human", id: "human-c", displayName: "Carol" },
      "edit",
      [
        { doc_path: DOC, heading_path: ["Overview"] },
        { doc_path: DOC, heading_path: ["Timeline"] },
        { doc_path: DOC, heading_path: ["Unclaimed"] },
      ],
    );
    const result = await checkProposalLocks({
      proposalId: challenger.id,
      targets: [target(["Overview"]), target(["Timeline"]), target(["Unclaimed"])],
    });

    expect(result.acquired).toBe(false);
    expect(result.conflicts).toHaveLength(2);
    const headings = result.conflicts.map((c) => c.target.heading_path[0]).sort();
    expect(headings).toEqual(["Overview", "Timeline"]);
  });

  it("excludeProposalId self-exclusion: a proposal never blocks itself", async () => {
    const holder = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    await transitionToInProgress(holder.id);

    // The inprogress proposal checks its own targets — must see no conflict.
    const result = await checkProposalLocks({
      proposalId: holder.id,
      targets: [target(["Overview"])],
    });
    expect(result.acquired).toBe(true);
    expect(result.conflicts).toHaveLength(0);

    // And via the index directly.
    const index = await ProposalFsmLockIndex.build({
      statuses: BLOCKING_LOCK_STATUSES,
      excludeProposalId: holder.id,
      claimScope: [DOC],
    });
    expect(index.holderFor(target(["Overview"]))).toBeNull();
  });

  it("assertProposalLocksAvailable throws ProposalLockConflictError carrying the full result", async () => {
    const holder = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    await transitionToInProgress(holder.id);
    const challenger = await createProposal(HUMAN_B, "edit", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);

    await expect(
      assertProposalLocksAvailable({
        proposalId: challenger.id,
        targets: [target(["Overview"])],
      }),
    ).rejects.toBeInstanceOf(ProposalLockConflictError);

    // ...and it succeeds when there is no conflict.
    await expect(
      assertProposalLocksAvailable({
        proposalId: challenger.id,
        targets: [target(["Unclaimed"])],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("committing-failure rollback target (caller context)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("human/DocSession proposal returns committing -> inprogress, preserving its target claim set", async () => {
    const holder = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    await transitionToInProgress(holder.id);
    await transitionToCommitting(holder.id);

    const restored = await rollbackCommittingToInProgress(holder.id);
    expect(restored.status).toBe("inprogress");
    expect(restored.targets.length).toBeGreaterThan(0);
    expect(sectionTargetsOf(restored.targets).map((t) => t.heading_path)).toEqual([["Overview"]]);
    expect((await readProposal(holder.id)).status).toBe("inprogress");
  });

  it("agent proposal rolls committing -> draft", async () => {
    const holder = await createProposal(AGENT, "agent edit", [
      { doc_path: DOC, heading_path: ["Timeline"] },
    ]);
    await transitionToCommitting(holder.id);

    const restored = await rollbackCommittingToDraft(holder.id);
    expect(restored.status).toBe("draft");
    expect((await readProposal(holder.id)).status).toBe("draft");
  });

  it("rollbackCommittingProposal dispatches by owner kind", async () => {
    const agentProp = await createProposal(AGENT, "agent edit", [
      { doc_path: DOC, heading_path: ["A"] },
    ]);
    await transitionToCommitting(agentProp.id);
    expect((await rollbackCommittingProposal(agentProp.id, "agent")).status).toBe("draft");

    const humanProp = await createProposal(HUMAN_A, "edit", [
      { doc_path: DOC, heading_path: ["B"] },
    ]);
    await transitionToInProgress(humanProp.id);
    await transitionToCommitting(humanProp.id);
    expect((await rollbackCommittingProposal(humanProp.id, "docsession")).status).toBe("inprogress");
  });
});
