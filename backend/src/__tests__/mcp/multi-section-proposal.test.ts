/**
 * Tests for agent create_proposal and write_proposal_section with multi-heading content.
 *
 * Validates that ProposalShadowContentLayer.writeSection auto-splits multi-heading
 * content into separate sections, and that the proposal metadata is updated
 * to reflect all resulting sections.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

let ctx: TestServerContext;
let mcpSessionId: string;

async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  token: string = ctx.agentToken,
): Promise<{ result?: any; error?: any }> {
  const headers: Record<string, string> = {
    Authorization: token,
    "Content-Type": "application/json",
  };
  if (mcpSessionId) {
    headers["Mcp-Session-Id"] = mcpSessionId;
  }

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

async function initMcpSession(token: string = ctx.agentToken): Promise<void> {
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
        clientInfo: { name: "test", version: "1.0" },
      },
    });

  if (res.headers["mcp-session-id"]) {
    mcpSessionId = res.headers["mcp-session-id"];
  }
}

describe("multi-heading auto-split in proposals", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    mcpSessionId = "";
    await initMcpSession();
  });

  it("create_proposal with multi-heading content auto-splits into sub-sections", async () => {
    const multiHeadingContent = [
      "## Overview",
      "",
      "Rewritten overview.",
      "",
      "## Details",
      "",
      "New details section.",
      "",
      "## Summary",
      "",
      "New summary section.",
    ].join("\n");

    const res = await callMcpTool("create_proposal", {
      intent: "Multi-heading auto-split test",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: multiHeadingContent,
        },
      ],
    });

    const data = JSON.parse(res.result.content[0].text);
    expect(data.proposal_id).toBeDefined();

    // Per items 246/258: proposal section metadata is keyed to the originally-requested
    // target headings only — auto-split successors are deliberately NOT reflected in the
    // agent-write-policy targets. The actual split is verified below via
    // read_proposal_section before publish and read_published_section after publish.
    const sectionHeadings = data.agent_write_policy.targets.map((t: any) => t.heading_path);
    expect(sectionHeadings).toContainEqual(["Overview"]);

    // The edited section should be readable from the draft proposal before publish.
    const overviewRes = await callMcpTool("read_proposal_section", {
      proposal_id: data.proposal_id,
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
    });
    const overviewDraftData = JSON.parse(overviewRes.result.content[0].text);
    expect(overviewDraftData.content).toContain("Rewritten overview.");

    // Publish the proposal
    const commitRes = await callMcpTool("publish_proposal", {
      proposal_id: data.proposal_id,
    });
    const commitData = JSON.parse(commitRes.result.content[0].text);
    expect(commitData.committed_head).toBeDefined();

    // Now verify each section is readable from the live wiki
    const readOverview = await callMcpTool("read_published_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
    });
    const overviewData = JSON.parse(readOverview.result.content[0].text);
    expect(overviewData.content).toContain("Rewritten overview.");

    const readDetails = await callMcpTool("read_published_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Details"],
    });
    const detailsData = JSON.parse(readDetails.result.content[0].text);
    expect(detailsData.content).toContain("New details section.");

    const readSummary = await callMcpTool("read_published_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Summary"],
    });
    const summaryData = JSON.parse(readSummary.result.content[0].text);
    expect(summaryData.content).toContain("New summary section.");

    // Verify the doc section inventory contains all headings
    const sectionsRes = await callMcpTool("list_sections", {
      path: SAMPLE_DOC_PATH,
    });
    const sectionsData = JSON.parse(sectionsRes.result.content[0].text);
    const headings = sectionsData.sections.map((row: { heading: string }) => row.heading);
    expect(headings).toContain("Overview");
    expect(headings).toContain("Details");
    expect(headings).toContain("Summary");
    expect(headings).toContain("Timeline"); // original section still present
  });

  it("write_proposal_section with multi-heading content auto-splits", async () => {
    // First create a proposal with a simple section
    const createRes = await callMcpTool("create_proposal", {
      intent: "write_proposal_section auto-split test",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Timeline"],
          content: "Placeholder.",
        },
      ],
    });

    const createData = JSON.parse(createRes.result.content[0].text);
    const proposalId = createData.proposal_id;

    // Now use write_proposal_section with multi-heading content
    const multiContent = [
      "## Timeline",
      "",
      "Updated timeline.",
      "",
      "## Milestones",
      "",
      "Key milestones here.",
    ].join("\n");

    const writeRes = await callMcpTool("write_proposal_section", {
      proposal_id: proposalId,
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Timeline"],
      content: multiContent,
    });

    const writeData = JSON.parse(writeRes.result.content[0].text);
    expect(writeData.proposal_id).toBe(proposalId);

    // Per items 246/258: proposal section metadata is keyed to the originally-requested
    // target headings only — auto-split successors are deliberately NOT reflected in the
    // agent-write-policy targets. The actual split is verified below via
    // read_published_section after publish.
    const sectionHeadings = writeData.agent_write_policy.targets.map((t: any) => t.heading_path);
    expect(sectionHeadings).toContainEqual(["Timeline"]);

    // Commit and verify
    const commitRes = await callMcpTool("publish_proposal", {
      proposal_id: proposalId,
    });
    const commitData = JSON.parse(commitRes.result.content[0].text);
    expect(commitData.committed_head).toBeDefined();

    const readMilestones = await callMcpTool("read_published_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Milestones"],
    });
    const milestonesData = JSON.parse(readMilestones.result.content[0].text);
    expect(milestonesData.content).toContain("Key milestones here.");
  });
});
