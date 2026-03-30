/**
 * US-4: Agent proposal with one section hard-blocked by a dirty session file.
 *
 * Flow:
 * 1. create_proposal with Overview + Timeline → Timeline hard-blocked (score=1.0),
 *    Overview passes
 * 2. commit_proposal → stays draft/blocked
 * 3. cancel_proposal
 * 4. create_proposal with only Overview → accepted
 * 5. commit_proposal → committed
 * 6. read_section: Overview = new content, Timeline = original
 * 7. Remove dirty file, create_proposal with replace for Timeline → accepted
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  createSampleDocument,
  SAMPLE_DOC_PATH,
  SAMPLE_SECTIONS,
} from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

let ctx: TestServerContext;
let mcpSessionId = "";

const AGENT_ID = "us4-contentpilot";
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
        clientInfo: { name: "test-us4", version: "1.0" },
      },
    });

  if (res.headers["mcp-session-id"]) {
    mcpSessionId = res.headers["mcp-session-id"];
  }
}

describe("US-4: hard-block, drop blocked section, recommit", () => {
  let sessionDocsContentRoot: string;
  const diskRelative = SAMPLE_DOC_PATH.replace(/^\//, "");

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Set up dirty session file for Timeline to hard-block it
    sessionDocsContentRoot = join(ctx.dataCtx.rootDir, "sessions", "docs", "content");
    const overlaySkeletonDir = join(sessionDocsContentRoot, join(diskRelative, "..").replace(/\\/g, "/"));
    const overlaySectionsDir = join(sessionDocsContentRoot, `${diskRelative}.sections`);
    await mkdir(overlaySkeletonDir, { recursive: true });
    await mkdir(overlaySectionsDir, { recursive: true });

    // Copy skeleton so heading resolution works in the overlay
    const canonicalSkeleton = join(ctx.dataCtx.rootDir, "content", diskRelative);
    await copyFile(canonicalSkeleton, join(sessionDocsContentRoot, diskRelative));

    // Write a dirty session file for Timeline
    await writeFile(join(overlaySectionsDir, "timeline.md"), "dirty timeline content from session");

    await initMcpSession();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("hard-blocks dirty section, drops it, commits remainder, then recommits after cleanup", async () => {
    // ── Step 1: create_proposal with Overview + Timeline → Timeline hard-blocked ──
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

    const data1 = JSON.parse(res1.result.content[0].text);
    expect(data1.outcome).toBe("blocked");

    // Timeline should be in blocked_sections with score=1.0 (dirty file = hard block)
    const blockedTimeline = data1.evaluation.blocked_sections.find(
      (s: any) => s.heading_path[0] === "Timeline",
    );
    expect(blockedTimeline).toBeDefined();
    expect(blockedTimeline.humanInvolvement_score).toBe(1.0);

    // Overview should be in passed_sections
    const passedOverview = data1.evaluation.passed_sections.find(
      (s: any) => s.heading_path[0] === "Overview",
    );
    expect(passedOverview).toBeDefined();

    // ── Step 2: commit_proposal → stays draft/blocked ──
    const commitBlocked = await callMcpTool("commit_proposal", {
      proposal_id: data1.proposal_id,
    });
    const commitBlockedData = JSON.parse(commitBlocked.result.content[0].text);
    expect(commitBlockedData.status).toBe("draft");
    expect(commitBlockedData.outcome).toBe("blocked");

    // ── Step 3: cancel_proposal ──
    const cancelRes = await callMcpTool("cancel_proposal", {
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

    // ── Step 5: commit_proposal → committed ──
    const commitRes = await callMcpTool("commit_proposal", {
      proposal_id: data4.proposal_id,
    });
    const commitData = JSON.parse(commitRes.result.content[0].text);
    expect(commitData.status).toBe("committed");

    // ── Step 6: read_section — Overview updated, Timeline unchanged ──
    const readOverview = await callMcpTool("read_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
    });
    expect(JSON.parse(readOverview.result.content[0].text).content).toContain(
      "Agent-updated overview for US4",
    );

    const readTimeline = await callMcpTool("read_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Timeline"],
    });
    expect(JSON.parse(readTimeline.result.content[0].text).content).toContain(
      SAMPLE_SECTIONS.timeline.trim(),
    );

    // ── Step 7: Remove dirty file, create_proposal for Timeline → accepted ──
    const overlaySectionsDir = join(sessionDocsContentRoot, `${diskRelative}.sections`);
    await rm(join(overlaySectionsDir, "timeline.md"), { force: true });
    // Also remove the overlay skeleton so the dirty file check returns clean
    await rm(join(sessionDocsContentRoot, diskRelative), { force: true });

    const res7 = await callMcpTool("create_proposal", {
      intent: "Now update timeline after human is done",
      replace: true,
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
  });
});
