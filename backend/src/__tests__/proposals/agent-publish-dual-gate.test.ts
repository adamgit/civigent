/**
 * Agent publish is gated by BOTH the proposal FSM locks AND the Agent Write
 * Policy, as DISTINCT typed failures (spec 12 §Locking + §Agent Write Policy).
 *
 *  - FSM lock failure: a competing exclusive lock makes the commit throw a
 *    `ProposalLockConflictError` carrying the conflicting target(s) — even when
 *    the write policy would allow the write.
 *  - Agent Write Policy failure: recent human involvement blocks the agent with
 *    a per-target `canWrite:false` + prose result — a distinct outcome, not a
 *    lock conflict.
 *
 * The two failure kinds are NOT collapsed into one generic rejection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, createHumanCommit } from "../helpers/sample-content.js";
import {
  createProposal,
  transitionToInProgress,
} from "../../storage/proposal-repository.js";
import { commitProposalUseCase } from "../../api/application/proposals.js";
import { ProposalLockConflictError } from "../../domain/proposal-fsm-locks.js";

const AGENT = { id: "agent-pub", type: "agent" as const, displayName: "Agent" };
const HUMAN = { id: "human-lock", type: "human" as const, displayName: "Human" };
const allowWrite = async () => true;

describe("agent publish dual gate (spec 12)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("FSM-lock gate: a competing exclusive lock makes the agent commit throw a typed lock conflict", async () => {
    // Competing human inprogress proposal locks Overview (no human COMMIT history,
    // so the write policy stays permissive — isolating the lock gate).
    const { id: competing } = await createProposal(HUMAN, "edit overview", [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
    ]);
    expect((await transitionToInProgress(competing)).acquired).toBe(true);

    const { id: agentProposal } = await createProposal(AGENT, "agent edits overview", [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Agent content.\n" },
    ]);

    let thrown: unknown;
    try {
      await commitProposalUseCase(agentProposal, AGENT, allowWrite);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProposalLockConflictError);
    const conflict = thrown as ProposalLockConflictError;
    const conflictedTargets = conflict.result.conflicts.map((c) =>
      c.target.kind === "section" ? c.target.heading_path : null,
    );
    expect(conflictedTargets).toContainEqual(["Overview"]);
  });

  it("Agent-Write-Policy gate: recent human involvement blocks the agent with a per-target policy result (not a lock conflict)", async () => {
    // Recent human commit on Overview → high involvement → agent blocked.
    await createHumanCommit(ctx.rootDir, SAMPLE_DOC_PATH, "overview.md", "Fresh human edit.\n", 0);

    const { id: agentProposal } = await createProposal(AGENT, "agent edits overview", [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Agent content.\n" },
    ]);

    const result = await commitProposalUseCase(agentProposal, AGENT, allowWrite);
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("expected blocked");
    expect(result.agentWritePolicy.canWrite).toBe(false);
    const overview = result.agentWritePolicy.targets.find(
      (t) => t.target.heading_path.length === 1 && t.target.heading_path[0] === "Overview",
    );
    expect(overview).toBeDefined();
    expect(overview!.canWrite).toBe(false);
    expect(typeof overview!.message).toBe("string");
    expect(overview!.message.length).toBeGreaterThan(0);
  });
});
