/**
 * Area J — DocSession guard removal.
 *
 * The MCP structural + filesystem tools used to hard-block document delete /
 * rename when a live DocSession existed on the target document
 * (`checkDocSessionGuard` in structural.ts; the `lookupDocSession` precondition
 * in filesystem.ts). Those guards are removed: MCP tools stage proposal DRAFT
 * content only and topology safety is enforced at the publish/commit boundary
 * (Areas B/C/F), not by blocking the staged write.
 *
 * These tests acquire a live DocSession on the target document, then assert the
 * structural `delete_document` stages a proposal draft, and that neither
 * structural `delete_document` nor filesystem `delete_file` return the removed
 * "active editing session" guard errors.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { acquireDocSession, lookupDocSession, releaseDocSession } from "../../crdt/ydoc-lifecycle.js";
import type { WriterIdentity } from "../../types/shared.js";

let ctx: TestServerContext;
let tier3SessionId = "";
let tier1SessionId = "";

const AGENT_ID = "guard-agent";
const agentToken = authFor(AGENT_ID, "agent");

const LIVE_WRITER: WriterIdentity = { id: "guard-human", type: "human", displayName: "Guard Human" };

async function callMcpTool(
  endpoint: "/mcp/tier1" | "/mcp/tier3",
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ body: any; sessionId: string }> {
  const headers: Record<string, string> = {
    Authorization: agentToken,
    "Content-Type": "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await request(ctx.app)
    .post(endpoint)
    .set(headers)
    .send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });

  return { body: res.body, sessionId: res.headers["mcp-session-id"] ?? sessionId };
}

async function initMcpSession(endpoint: "/mcp/tier1" | "/mcp/tier3"): Promise<string> {
  const res = await request(ctx.app)
    .post(endpoint)
    .set("Authorization", agentToken)
    .set("Content-Type", "application/json")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "guard", version: "1.0" } },
    });
  return res.headers["mcp-session-id"] ?? "";
}

describe("Area J — structural/filesystem delete stage while a DocSession exists", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    tier3SessionId = await initMcpSession("/mcp/tier3");
    tier1SessionId = await initMcpSession("/mcp/tier1");

    // Bring up a live DocSession (with an editor socket) on the target doc.
    const baseHead = await getHeadSha(ctx.dataCtx.rootDir);
    await acquireDocSession(SAMPLE_DOC_PATH, LIVE_WRITER.id, baseHead, LIVE_WRITER, "sock-guard");
    // Sanity: the session exists, which previously would have blocked the tools.
    expect(lookupDocSession(SAMPLE_DOC_PATH)).toBeDefined();
  });

  afterAll(async () => {
    await releaseDocSession(SAMPLE_DOC_PATH, LIVE_WRITER.id, "sock-guard");
    await ctx.cleanup();
  });

  it("structural delete_document stages a proposal draft despite the live DocSession", async () => {
    const createRes = await callMcpTool("/mcp/tier3", tier3SessionId, "create_proposal", {
      intent: "structural delete while live session exists",
      sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "x\n" }],
    });
    tier3SessionId = createRes.sessionId;
    const proposalId = JSON.parse(createRes.body.result.content[0].text).proposal_id;

    const res = await callMcpTool("/mcp/tier3", tier3SessionId, "delete_document", {
      proposal_id: proposalId,
      path: SAMPLE_DOC_PATH,
    });
    tier3SessionId = res.sessionId;

    // Not the removed session-contention guard error.
    expect(res.body.result.isError).toBeFalsy();
    const data = JSON.parse(res.body.result.content[0].text);
    expect(data.deleted).toBe(true);
    expect(data.proposal_id).toBe(proposalId);
  });

  it("filesystem delete_file (tier1) does not return the removed 'active editing session' guard error", async () => {
    const res = await callMcpTool("/mcp/tier1", tier1SessionId, "delete_file", { path: SAMPLE_DOC_PATH });
    tier1SessionId = res.sessionId;
    const text = res.body.result.content[0].text as string;
    // The removed precondition produced exactly this message; it must be gone.
    expect(text).not.toContain("active editing session");
  });
});
