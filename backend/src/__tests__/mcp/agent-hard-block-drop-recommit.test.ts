/**
 * US-4: Agent proposal with one section hard-blocked, drop it, commit the
 * remainder, then recommit the dropped section once the block clears.
 *
 * MW-12 migration: the original scenario provoked the block via a deleted
 * dirty-session-file overlay (`sessions/sections/content`) and asserted the
 * removed `evaluation.blocked_sections`/`passed_sections` + `humanInvolvement_score`
 * response shape. Both are gone. This rewrite provokes a GENUINE block through
 * the new `AgentWritePolicy` (human-involvement compatibility policy): a very
 * recent HUMAN commit to the Timeline section drives its recency score over the
 * 0.5 threshold so that target is declined, while Overview (no recent human
 * activity) passes. It asserts the prose-`message` blocked-response contract
 * (top-level + per-target prose, no bare reason-code/enum/threshold fields), then
 * drops Timeline, commits Overview, and finally — after a backdated human commit
 * clears Timeline's recency — recommits Timeline successfully.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  createSampleDocument,
  createHumanCommit,
  SAMPLE_DOC_PATH,
  SAMPLE_SECTIONS,
} from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import { updateAdminConfig } from "../../admin-config.js";

let ctx: TestServerContext;
let mcpSessionId = "";

const AGENT_ID = "us4-contentpilot";
const agentToken = authFor(AGENT_ID, "agent");

// Retired bare codes / thresholds / enums-as-explanation that must NOT appear in
// any blocked response body (the contract MW-11/Area M established).
const FORBIDDEN_CODE_FIELDS = [
  "block_reason",
  "blocked_reason",
  "per_section_threshold",
  "aggregate_threshold",
  "aggregate_impact",
  "humanInvolvement_score",
  "blocked_sections",
  "passed_sections",
];

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
        clientInfo: { name: "test-us4", version: "1.0" },
      },
    });

  if (res.headers["mcp-session-id"]) {
    mcpSessionId = res.headers["mcp-session-id"];
  }
}

describe("US-4: hard-block, drop blocked section, recommit", () => {
  beforeAll(async () => {
    updateAdminConfig({ humanInvolvement_preset: "eager" });
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Provoke a genuine per-target hard block through the new AgentWritePolicy:
    // a fresh HUMAN commit to ONLY the Timeline section drives its recency score
    // over threshold. Overview is left with its old commit → it still passes, so
    // the proposal blocks on Timeline alone (not via aggregate escalation).
    await createHumanCommit(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "timeline.md",
      `${SAMPLE_SECTIONS.timeline}\nHuman just refined the timeline.\n`,
      0.01, // ~36s ago → score ≈ 1.0
    );

    await initMcpSession();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("hard-blocks the recently-human-edited section, drops it, commits remainder, then recommits after the block clears", async () => {
    // ── Step 1: create_proposal Overview + Timeline → Timeline declined ──
    const res1 = await callMcpTool("create_proposal", {
      intent: "Update overview and timeline",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "Agent-updated overview for US4.\n",
        },
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Timeline"],
          content: "Agent-updated timeline for US4.\n",
        },
      ],
    });

    const rawText1: string = res1.result.content[0].text;
    const data1 = JSON.parse(rawText1);
    expect(data1.outcome).toBe("blocked");

    // Prose contract: required top-level prose `message`, no bare codes.
    expect(typeof data1.message).toBe("string");
    expect(data1.message.length).toBeGreaterThan(20);
    for (const field of FORBIDDEN_CODE_FIELDS) {
      expect(rawText1).not.toContain(`"${field}"`);
    }

    // Per-target prose: Timeline declined with prose, Overview allowed.
    const targets1 = data1.agent_write_policy.targets as Array<{
      heading_path: string[];
      can_write: boolean;
      message: string;
    }>;
    const timeline1 = targets1.find((t) => t.heading_path[0] === "Timeline");
    const overview1 = targets1.find((t) => t.heading_path[0] === "Overview");
    expect(timeline1).toBeDefined();
    expect(timeline1!.can_write).toBe(false);
    expect(timeline1!.message.length).toBeGreaterThan(20);
    expect(overview1).toBeDefined();
    expect(overview1!.can_write).toBe(true);

    // ── Step 2: publish_proposal → stays draft/blocked, same prose contract ──
    const commitBlocked = await callMcpTool("publish_proposal", {
      proposal_id: data1.proposal_id,
    });
    const rawBlocked: string = commitBlocked.result.content[0].text;
    const commitBlockedData = JSON.parse(rawBlocked);
    expect(commitBlockedData.status).toBe("draft");
    expect(commitBlockedData.outcome).toBe("blocked");
    expect(typeof commitBlockedData.message).toBe("string");
    expect(commitBlockedData.message.length).toBeGreaterThan(20);
    for (const field of FORBIDDEN_CODE_FIELDS) {
      expect(rawBlocked).not.toContain(`"${field}"`);
    }

    // ── Step 3: withdraw_proposal ──
    const cancelRes = await callMcpTool("withdraw_proposal", {
      proposal_id: data1.proposal_id,
    });
    expect(JSON.parse(cancelRes.result.content[0].text).status).toBe("withdrawn");

    // ── Step 4: create_proposal with only Overview → accepted ──
    const res4 = await callMcpTool("create_proposal", {
      intent: "Update overview only (dropped timeline)",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "Agent-updated overview for US4.\n",
        },
      ],
    });

    const data4 = JSON.parse(res4.result.content[0].text);
    expect(data4.outcome).toBe("accepted");

    // ── Step 5: publish_proposal → committed ──
    const commitRes = await callMcpTool("publish_proposal", {
      proposal_id: data4.proposal_id,
    });
    const commitData = JSON.parse(commitRes.result.content[0].text);
    expect(commitData.status).toBe("committed");

    // ── Step 6: read_published_section — Overview updated, Timeline unchanged ──
    const readOverview = await callMcpTool("read_published_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
    });
    expect(readOverview.result.content[0].text).toContain(
      "Agent-updated overview for US4",
    );

    const readTimeline = await callMcpTool("read_published_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Timeline"],
    });
    expect(readTimeline.result.content[0].text).toContain(
      SAMPLE_SECTIONS.timeline.trim(),
    );

    // ── Step 7: clear the Timeline block, then recommit Timeline → accepted ──
    // A backdated human commit to Timeline becomes the newest commit touching the
    // file but reports an old author timestamp, so its recency score collapses
    // and the agent write policy stops declining it.
    await createHumanCommit(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "timeline.md",
      `${SAMPLE_SECTIONS.timeline}\nHuman finished long ago.\n`,
      24 * 365, // ~1 year ago → score ≈ 0
    );

    const res7 = await callMcpTool("create_proposal", {
      intent: "Now update timeline after human is done",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Timeline"],
          content: "Agent-updated timeline after cleanup.\n",
        },
      ],
    });

    const data7 = JSON.parse(res7.result.content[0].text);
    expect(data7.outcome).toBe("accepted");
    const publish7 = await callMcpTool("publish_proposal", {
      proposal_id: data7.proposal_id,
    });
    expect(JSON.parse(publish7.result.content[0].text).status).toBe("committed");
  });
});
