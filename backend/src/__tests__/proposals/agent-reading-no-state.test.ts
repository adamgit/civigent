/**
 * `agent:reading` no-state / no-gating semantics (spec 06 §Signals).
 *
 * The reading signal is fire-and-forget: it must NOT create backend state, change
 * the Agent Write Policy / human-involvement score, block or throttle reads. No
 * persistent activity record is written.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { createProposal, listProposalsByStatuses } from "../../storage/proposal-repository.js";
import { AgentWritePolicy } from "../../domain/agent-write-policy.js";

const ALL_STATUSES = ["draft", "pending", "inprogress", "committing", "committed", "withdrawn"] as const;
const AGENT = { id: "reader-agent", type: "agent" as const, displayName: "Reader" };

async function readSections(ctx: TestServerContext): Promise<number> {
  const res = await request(ctx.app)
    .get(`/api/documents${SAMPLE_DOC_PATH}/sections`)
    .set("Authorization", ctx.agentToken);
  return res.status;
}

describe("agent:reading no-state / no-gating (spec 06)", () => {
  let ctx: TestServerContext;
  let prevAuthMode: string | undefined;

  beforeEach(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("does not change the Agent Write Policy / HI score, does not throttle, and creates no state", async () => {
    // Baseline: write-policy evaluation for an agent proposal on Overview.
    const { id } = await createProposal(AGENT, "agent edits overview", [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "x\n" },
    ]);
    const before = await AgentWritePolicy.evaluateProposal(id);
    const proposalsBefore = (await listProposalsByStatuses(ALL_STATUSES)).length;

    // Many rapid reads — none blocked or throttled.
    for (let i = 0; i < 8; i++) {
      expect(await readSections(ctx)).toBe(200);
    }

    // Write policy / HI score is unchanged by reading.
    const after = await AgentWritePolicy.evaluateProposal(id);
    expect(after.canWrite).toBe(before.canWrite);
    expect(after.targets[0].details.score).toBe(before.targets[0].details.score);
    expect(after.targets[0].canWrite).toBe(before.targets[0].canWrite);

    // No persistent state created by reading: the proposal set is unchanged.
    const proposalsAfter = (await listProposalsByStatuses(ALL_STATUSES)).length;
    expect(proposalsAfter).toBe(proposalsBefore);
  });
});
