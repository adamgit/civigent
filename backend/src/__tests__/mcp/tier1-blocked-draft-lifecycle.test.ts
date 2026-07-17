/**
 * A blocked Tier 1 write is returned to the agent as a durable draft: the
 * persisted proposal must be in `draft` (not `pending`, which is discarded as
 * debris on restart), and the next write in the same MCP session must find it
 * via session-local memory and auto-withdraw it. Proposal files carry NO MCP
 * session identity (task 708) — the affinity lives only in the in-memory
 * session object.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { readProposal } from "../../storage/proposal-repository.js";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  createHumanCommit,
  createSampleDocument,
  SAMPLE_DOC_PATH,
} from "../helpers/sample-content.js";

let ctx: TestServerContext;

const SESSION_ID = "tier1-blocked-draft-lifecycle";

async function writeBlocked(content: string): Promise<{ proposal_id: string; status: string }> {
  const response = await request(ctx.app)
    .post("/mcp/tier1")
    .set({
      Authorization: ctx.agentToken,
      "Content-Type": "application/json",
      "Mcp-Session-Id": SESSION_ID,
    })
    .send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "write_file",
        arguments: {
          path: SAMPLE_DOC_PATH,
          content,
        },
      },
    });

  return JSON.parse(response.body.result.content[0].text);
}

describe("Tier 1 blocked draft lifecycle", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    await createHumanCommit(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Fresh human-authored overview.\n",
      0.01,
    );
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("persists blocked writes as drafts and replaces the prior same-session draft", async () => {
    const first = await writeBlocked(
      "## Overview\n\nFirst blocked agent rewrite.\n\n## Timeline\n\nTimeline.\n",
    );
    const second = await writeBlocked(
      "## Overview\n\nSecond blocked agent rewrite.\n\n## Timeline\n\nTimeline.\n",
    );

    expect(first.status).toBe("draft");
    expect(second.status).toBe("draft");

    const persistedFirst = await readProposal(first.proposal_id);
    const persistedSecond = await readProposal(second.proposal_id);

    // The second write auto-withdrew the first via session-local memory; the
    // second is a durable on-disk draft. Neither carries any session identity.
    expect(persistedFirst.status).toBe("withdrawn");
    expect(persistedSecond.status).toBe("draft");
    expect("agent_session_id" in persistedFirst).toBe(false);
    expect("agent_session_id" in persistedSecond).toBe(false);
  });
});
