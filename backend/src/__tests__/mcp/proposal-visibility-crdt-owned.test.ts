/**
 * Area J — proposal-visibility audit.
 *
 * A CRDT-owned (`proposalAdoptionId`-bearing) `inprogress`/`committing` proposal is a
 * system artefact materialized by a live DocSession actor (spec 10 "One active
 * proposal per DocSession"), NOT an agent-authored proposal. It must never be a
 * live-state side channel on the agent MCP surface:
 *   - list_proposals (no status filter) must NOT include it.
 *   - my_proposals must NOT include it.
 *   - read_proposal must REFUSE it with a prose message (no content).
 * A normal agent draft proposal stays fully visible and readable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import { getOrCreateInProgressProposalForAdoptionId } from "../../storage/proposal-repository.js";
import type { WriterIdentity } from "../../types/shared.js";

let ctx: TestServerContext;
let mcpSessionId = "";

const AGENT_ID = "vis-agent";
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

async function initMcpSession(): Promise<void> {
  const res = await request(ctx.app)
    .post("/mcp/tier3")
    .set("Authorization", agentToken)
    .set("Content-Type", "application/json")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "vis", version: "1.0" } },
    });
  if (res.headers["mcp-session-id"]) mcpSessionId = res.headers["mcp-session-id"];
}

describe("Area J — CRDT-owned proposal visibility on the agent MCP surface", () => {
  let crdtProposalId = "";
  let agentDraftId = "";

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    await initMcpSession();

    // A normal agent-authored draft (must stay visible).
    const draftRes = await callMcpTool("create_proposal", {
      intent: "Agent authored draft",
      sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Authored.\n" }],
    });
    agentDraftId = JSON.parse(draftRes.result.content[0].text).proposal_id;

    // A CRDT-owned `inprogress` proposal, as a live DocSession actor would
    // lazily materialize it (keyed on its owning proposalAdoptionId).
    const sessionWriter: WriterIdentity = { id: "live-human", type: "human", displayName: "Live Human" };
    const { id } = await getOrCreateInProgressProposalForAdoptionId({
      proposalAdoptionId: "docsession-abc",
      docPath: SAMPLE_DOC_PATH,
      writer: sessionWriter,
      intent: "live edit",
      sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
    });
    crdtProposalId = id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("list_proposals (no filter) hides the CRDT-owned proposal but keeps the agent draft", async () => {
    const res = await callMcpTool("list_proposals", {});
    const proposals = JSON.parse(res.result.content[0].text).proposals as Array<{ id: string }>;
    const ids = proposals.map((p) => p.id);
    expect(ids).not.toContain(crdtProposalId);
    expect(ids).toContain(agentDraftId);
  });

  it("my_proposals hides the CRDT-owned proposal", async () => {
    const res = await callMcpTool("my_proposals", {});
    const proposals = JSON.parse(res.result.content[0].text).proposals as Array<{ id: string }>;
    expect(proposals.map((p) => p.id)).not.toContain(crdtProposalId);
  });

  it("read_proposal refuses the CRDT-owned proposal with a prose message and no content", async () => {
    const res = await callMcpTool("read_proposal", { proposal_id: crdtProposalId });
    // Refusal is surfaced as a tool error (isError) carrying prose text, never
    // proposal content / section_content.
    expect(res.result.isError).toBe(true);
    const text = res.result.content[0].text as string;
    expect(text).toContain("live editing session");
    expect(text).not.toContain("section_content");
  });

  it("read_proposal still returns content for a normal agent draft", async () => {
    const res = await callMcpTool("read_proposal", { proposal_id: agentDraftId });
    expect(res.result.isError).toBeFalsy();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.proposal.id).toBe(agentDraftId);
    expect(data.section_content).toBeDefined();
  });
});
