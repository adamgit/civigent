/**
 * Area M — create_proposal(replace: true) response surfaces the withdrawn draft
 * fact, and omits it when no prior draft existed.
 *
 * The withdraw-fires case (withdrawn_proposal_id + message present) is covered by
 * `agent-replace-stale-draft.test.ts` step 4. This locks the NEGATIVE case:
 * replace: true with no existing draft must NOT claim a withdrawal happened.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

let ctx: TestServerContext;
let mcpSessionId = "";
const agentToken = authFor("replace-response-agent", "agent");

async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = { Authorization: agentToken, "Content-Type": "application/json" };
  if (mcpSessionId) headers["Mcp-Session-Id"] = mcpSessionId;
  const res = await request(ctx.app)
    .post("/mcp/tier3")
    .set(headers)
    .send({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: args } });
  if (res.headers["mcp-session-id"]) mcpSessionId = res.headers["mcp-session-id"];
  return res.body;
}

async function initMcpSession(): Promise<void> {
  const res = await request(ctx.app)
    .post("/mcp/tier3")
    .set("Authorization", agentToken)
    .set("Content-Type", "application/json")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "replace-resp", version: "1.0" } },
    });
  if (res.headers["mcp-session-id"]) mcpSessionId = res.headers["mcp-session-id"];
}

describe("create_proposal(replace: true) response — no prior draft", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    await initMcpSession();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("replace: true with NO existing draft → no withdrawn_proposal_id, no withdrawal claim", async () => {
    const res = await callMcpTool("create_proposal", {
      intent: "First-ever draft with replace flag set",
      replace: true,
      sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "fresh content.\n" }],
    });

    const data = JSON.parse(res.result.content[0].text);
    expect(data.status).toBe("draft");
    expect(data.outcome).toBe("accepted");
    // No prior draft existed → the withdrawal fields must be absent.
    expect(data.withdrawn_proposal_id).toBeUndefined();
    if (data.message) {
      expect(data.message.toLowerCase()).not.toContain("withdrawn");
    }
  });
});
