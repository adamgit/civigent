/**
 * Human publish bypasses the Agent Write Policy while still respecting RBAC and
 * proposal FSM rules (spec 12: "Human proposal publication does not call Agent
 * Write Policy"; spec 02 §3 Invariants 2/4).
 *
 *  - Bypass: a recent-human-involvement condition that BLOCKS an agent does NOT
 *    block a human publish — it commits.
 *  - RBAC: a human without document write permission is refused (403).
 *  - FSM: a human can publish only from `inprogress` (publishing a `draft` is 409).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH, createHumanCommit } from "../helpers/sample-content.js";
import { createProposal, transitionToInProgress, readProposal } from "../../storage/proposal-repository.js";
import { commitProposalUseCase } from "../../api/application/proposals.js";

const HUMAN = { id: "human-pub", type: "human" as const, displayName: "Human" };
const allowWrite = async () => true;
const denyWrite = async () => false;

async function humanInprogressOnOverview(): Promise<string> {
  const { id } = await createProposal(HUMAN, "human edits overview", [
    { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
  ]);
  expect((await transitionToInProgress(id)).acquired).toBe(true);
  return id;
}

describe("human publish bypasses Agent Write Policy (spec 12)", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("commits despite a recent-human-involvement condition that would block an agent", async () => {
    // This condition blocks AGENTS (see agent-publish-dual-gate.test.ts) — a human
    // must publish through it unchanged.
    await createHumanCommit(ctx.rootDir, SAMPLE_DOC_PATH, "overview.md", "Recent human edit.\n", 0);

    const id = await humanInprogressOnOverview();
    const result = await commitProposalUseCase(id, HUMAN, allowWrite);

    expect(result.kind).toBe("committed");
    expect((await readProposal(id)).status).toBe("committed");
  });

  it("still enforces RBAC: a human without write permission is refused (403)", async () => {
    const id = await humanInprogressOnOverview();
    const result = await commitProposalUseCase(id, HUMAN, denyWrite);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.status).toBe(403);
  });

  it("still enforces FSM rules: a human cannot publish from draft (409)", async () => {
    // Draft (locks never acquired) → not a publishable state for a human.
    const { id } = await createProposal(HUMAN, "still a draft", [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
    ]);
    const result = await commitProposalUseCase(id, HUMAN, allowWrite);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.status).toBe(409);
  });
});
