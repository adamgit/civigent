/**
 * US-1: Agent creates a multi-document proposal, gets blocked by HI score,
 * re-submits with per-section justifications, commits, and verifies canonical content.
 *
 * Uses MCP tier3 JSON-RPC transport exclusively.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  createSampleDocument,
  createSampleDocument2,
  createHumanCommit,
  SAMPLE_DOC_PATH,
  SAMPLE_DOC_PATH_2,
} from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

let ctx: TestServerContext;
let mcpSessionId = "";

const AGENT_ID = "us1-contentpilot";
const agentToken = authFor(AGENT_ID, "agent");

async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  token: string = agentToken,
): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: token,
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

  if (res.headers["mcp-session-id"]) {
    mcpSessionId = res.headers["mcp-session-id"];
  }

  return res.body;
}

async function initMcpSession(token: string = agentToken): Promise<void> {
  const res = await request(ctx.app)
    .post("/mcp/tier3")
    .set("Authorization", token)
    .set("Content-Type", "application/json")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-us1", version: "1.0" },
      },
    });

  if (res.headers["mcp-session-id"]) {
    mcpSessionId = res.headers["mcp-session-id"];
  }
}

describe("US-1: multi-document proposal with justification bypass", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    await createSampleDocument2(ctx.dataCtx.rootDir);

    // Add human commits ~1.5h ago to both docs so HI score ≈ 0.59 (above 0.5)
    await createHumanCommit(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Human-edited overview content.\n",
      1.5,
    );
    await createHumanCommit(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH_2,
      "principles.md",
      "Human-edited principles content.\n",
      1.5,
    );

    await initMcpSession();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("blocks proposal without justifications, accepts with justifications, commits and verifies", async () => {
    // ── Step 1: create_proposal without justifications → blocked ──
    const blocked = await callMcpTool("create_proposal", {
      intent: "Update overview and principles across docs",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "Agent-updated overview.\n",
        },
        {
          doc_path: SAMPLE_DOC_PATH_2,
          heading_path: ["Principles"],
          content: "Agent-updated principles.\n",
        },
      ],
    });

    const blockedData = JSON.parse(blocked.result.content[0].text);
    expect(blockedData.outcome).toBe("blocked");
    expect(blockedData.evaluation.blocked_sections.length).toBeGreaterThanOrEqual(1);

    // ── Step 2: cancel the blocked proposal ──
    const cancelRes = await callMcpTool("cancel_proposal", {
      proposal_id: blockedData.proposal_id,
    });
    const cancelData = JSON.parse(cancelRes.result.content[0].text);
    expect(cancelData.status).toBe("withdrawn");

    // ── Step 3: create_proposal WITH justifications → accepted ──
    const accepted = await callMcpTool("create_proposal", {
      intent: "Update overview and principles with justification",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "Agent-updated overview.\n",
          justification: "Aligning overview with Q2 strategy pivot",
        },
        {
          doc_path: SAMPLE_DOC_PATH_2,
          heading_path: ["Principles"],
          content: "Agent-updated principles.\n",
          justification: "Updating architecture principles per tech-lead directive",
        },
      ],
    });

    const acceptedData = JSON.parse(accepted.result.content[0].text);
    expect(acceptedData.outcome).toBe("accepted");
    expect(acceptedData.evaluation.passed_sections.length).toBe(2);

    // Verify scores are reduced by 0.1 due to justification
    for (const section of acceptedData.evaluation.passed_sections) {
      expect(section.humanInvolvement_score).toBeLessThan(0.5);
    }

    // ── Step 4: commit_proposal → committed ──
    const commitRes = await callMcpTool("commit_proposal", {
      proposal_id: acceptedData.proposal_id,
    });
    const commitData = JSON.parse(commitRes.result.content[0].text);
    expect(commitData.status).toBe("committed");
    expect(commitData.committed_head).toBeTruthy();

    // ── Step 5: read_section on both docs → canonical content updated ──
    const readOverview = await callMcpTool("read_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
    });
    const overviewData = JSON.parse(readOverview.result.content[0].text);
    expect(overviewData.content).toContain("Agent-updated overview");

    const readPrinciples = await callMcpTool("read_section", {
      doc_path: SAMPLE_DOC_PATH_2,
      heading_path: ["Principles"],
    });
    const principlesData = JSON.parse(readPrinciples.result.content[0].text);
    expect(principlesData.content).toContain("Agent-updated principles");
  });
});
