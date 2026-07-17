/**
 * Writes/publishes against a non-mutable proposal return plain, honest state
 * errors (task 744): the error names the state and nothing more — no inline
 * draft-id enumeration, no recovery prose. Agents that need their draft state
 * call my_proposals / list_proposals or use the explicit proposal_id they were
 * given. FSM transitions are unchanged (still a tool error).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

let ctx: TestServerContext;
let mcpSessionId = "";

const AGENT_ID = "terminal-error-agent";
const agentToken = authFor(AGENT_ID, "agent");

async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: agentToken,
    "Content-Type": "application/json",
  };
  if (mcpSessionId) headers["Mcp-Session-Id"] = mcpSessionId;

  const res = await request(ctx.app)
    .post("/mcp/tier3")
    .set(headers)
    .send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });

  if (res.headers["mcp-session-id"]) mcpSessionId = res.headers["mcp-session-id"];
  return res.body;
}

/** Extract the tool result text whether it comes back as a success or error body. */
function toolText(body: any): string {
  const content = body.result?.content ?? body.error?.data?.content;
  return content?.[0]?.text ?? JSON.stringify(body);
}

describe("non-mutable proposal state errors are plain", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("write to a committed proposal → plain state error, no inline draft ids", async () => {
    // P1: the proposal we will commit (become terminal).
    const c1 = await callMcpTool("create_proposal", {
      intent: "Committed proposal",
      sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "committed body.\n" }],
    });
    const P1 = JSON.parse(c1.result.content[0].text).proposal_id;

    // P2: a separate surviving draft that must NOT be enumerated in the error.
    const c2 = await callMcpTool("create_proposal", {
      intent: "Surviving active draft",
      sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "still a draft.\n" }],
    });
    const P2 = JSON.parse(c2.result.content[0].text).proposal_id;

    const pub = await callMcpTool("publish_proposal", { proposal_id: P1 });
    expect(JSON.parse(pub.result.content[0].text).status).toBe("committed");

    const bad = await callMcpTool("write_proposal_section", {
      proposal_id: P1,
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
      content: "trying to write to a dead proposal.\n",
    });
    const text = toolText(bad);

    expect(text).toBe("Cannot modify proposal in committed state.");
    expect(text).not.toContain(P2); // no draft-id theatre
  });

  it("publish a withdrawn proposal → plain state error", async () => {
    const c = await callMcpTool("create_proposal", {
      intent: "To be withdrawn",
      sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "will withdraw.\n" }],
    });
    const P = JSON.parse(c.result.content[0].text).proposal_id;

    const wd = await callMcpTool("withdraw_proposal", {
      proposal_id: P,
      reason: "superseded by a newer plan",
    });
    expect(wd.error).toBeUndefined();

    const bad = await callMcpTool("publish_proposal", { proposal_id: P });
    expect(toolText(bad)).toBe("Cannot publish proposal in withdrawn state.");
  });
});
