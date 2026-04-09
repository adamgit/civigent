/**
 * US-5: Agent replaces a stale draft with replace=true.
 *
 * Tier-3 agents are exempt from the single-draft limit per the spec — they may
 * have multiple simultaneous drafts. This test exercises the replace=true convenience
 * which auto-withdraws one existing draft (whichever findDraftProposalByWriter returns
 * first) before creating the new proposal.
 *
 * Flow:
 * 1. create_proposal as contentpilot → draft P1, accepted
 * 2. create_proposal same writer without replace → second draft allowed (tier-3 exempt) → P2
 * 3. my_proposals status=draft → 2 entries (P1 and P2)
 * 4. create_proposal with replace=true, 2 sections → withdraws ONE existing draft, creates P3
 * 5. verify exactly one of P1/P2 is withdrawn
 * 6. commit_proposal P3 → committed
 * 7. read_section both headings → new content
 * 8. create_proposal with replace=true (still has surviving draft) → succeeds
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  createSampleDocument,
  SAMPLE_DOC_PATH,
} from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

let ctx: TestServerContext;
let mcpSessionId = "";

const AGENT_ID = "us5-contentpilot";
const agentToken = authFor(AGENT_ID, "agent");

async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<any> {
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

  if (res.headers["mcp-session-id"]) {
    mcpSessionId = res.headers["mcp-session-id"];
  }

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
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-us5", version: "1.0" },
      },
    });

  if (res.headers["mcp-session-id"]) {
    mcpSessionId = res.headers["mcp-session-id"];
  }
}

describe("US-5: replace stale draft with replace=true", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    await initMcpSession();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("full replace flow: create, conflict, replace, commit, and idempotent replace", async () => {
    // ── Step 1: create_proposal → draft P1, accepted ──
    const res1 = await callMcpTool("create_proposal", {
      intent: "Initial draft for replacement test",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "P1 overview content.\n",
        },
      ],
    });

    const data1 = JSON.parse(res1.result.content[0].text);
    expect(data1.status).toBe("draft");
    expect(data1.outcome).toBe("accepted");
    const P1 = data1.proposal_id;

    // ── Step 2: create_proposal same writer WITHOUT replace → second draft allowed (tier-3 exempt) ──
    const res2 = await callMcpTool("create_proposal", {
      intent: "Second draft (tier-3 exempt from single-draft limit)",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "P2 overview content.\n",
        },
      ],
    });

    const data2 = JSON.parse(res2.result.content[0].text);
    expect(data2.status).toBe("draft");
    expect(data2.outcome).toBe("accepted");
    const P2 = data2.proposal_id;
    expect(P2).not.toBe(P1);

    // ── Step 3: my_proposals status=draft → 2 entries (P1 and P2) ──
    const myRes = await callMcpTool("my_proposals", { status: "draft" });
    const myData = JSON.parse(myRes.result.content[0].text);
    expect(myData.proposals).toHaveLength(2);
    const draftIds = myData.proposals.map((p: { id: string }) => p.id).sort();
    expect(draftIds).toEqual([P1, P2].sort());

    // ── Step 4: create_proposal with replace=true, 2 sections → withdraws one existing draft, creates P3 ──
    const res4 = await callMcpTool("create_proposal", {
      intent: "Replacement draft with two sections",
      replace: true,
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "P3 overview content.\n",
        },
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Timeline"],
          content: "P3 timeline content.\n",
        },
      ],
    });

    const data4 = JSON.parse(res4.result.content[0].text);
    expect(data4.status).toBe("draft");
    expect(data4.outcome).toBe("accepted");
    const P3 = data4.proposal_id;
    expect(P3).not.toBe(P1);
    expect(P3).not.toBe(P2);

    // ── Step 5: verify exactly one of P1/P2 is now withdrawn ──
    const readP1 = await callMcpTool("read_proposal", { proposal_id: P1 });
    const readP2 = await callMcpTool("read_proposal", { proposal_id: P2 });
    const p1Status = JSON.parse(readP1.result.content[0].text).proposal.status;
    const p2Status = JSON.parse(readP2.result.content[0].text).proposal.status;
    const withdrawnCount = [p1Status, p2Status].filter((s) => s === "withdrawn").length;
    const draftCount = [p1Status, p2Status].filter((s) => s === "draft").length;
    expect(withdrawnCount).toBe(1);
    expect(draftCount).toBe(1);

    // ── Step 6: commit_proposal P3 → committed ──
    const commitRes = await callMcpTool("commit_proposal", { proposal_id: P3 });
    const commitData = JSON.parse(commitRes.result.content[0].text);
    expect(commitData.status).toBe("committed");

    // ── Step 7: read_section both headings → new content from P3 ──
    const readOverview = await callMcpTool("read_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
    });
    expect(JSON.parse(readOverview.result.content[0].text).content).toContain("P3 overview");

    const readTimeline = await callMcpTool("read_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Timeline"],
    });
    expect(JSON.parse(readTimeline.result.content[0].text).content).toContain("P3 timeline");

    // ── Step 8: create_proposal with replace=true (still has surviving draft) → succeeds ──
    const res8 = await callMcpTool("create_proposal", {
      intent: "Replace surviving draft after commit",
      replace: true,
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "P4 content.\n",
        },
      ],
    });

    const data8 = JSON.parse(res8.result.content[0].text);
    expect(data8.status).toBe("draft");
    expect(data8.outcome).toBe("accepted");
  });
});
