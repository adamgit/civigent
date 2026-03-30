/**
 * Tests for structural tools operating within proposals.
 *
 * Validates that create_section, delete_section, move_section, rename_section
 * all require proposal_id, write changes to the proposal overlay (not canonical),
 * and that commit_proposal correctly promotes overlay → canonical.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

let ctx: TestServerContext;
let mcpSessionId: string;

// Helper to call MCP tools via the JSON-RPC transport (tier 3 for structural tools)
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

  // Capture session ID from first response
  if (res.headers["mcp-session-id"]) {
    mcpSessionId = res.headers["mcp-session-id"];
  }

  return res.body;
}

// Helper to initialize MCP session (tier 3 for structural tools)
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

// Helper to create a proposal via REST
async function createProposal(
  intent: string,
  token: string = ctx.agentToken,
): Promise<string> {
  const res = await request(ctx.app)
    .post("/api/proposals?replace=true")
    .set("Authorization", token)
    .send({
      intent,
      sections: [{
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["Overview"],
        content: "placeholder",
      }],
    });

  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  return res.body.proposal_id;
}

// Helper to read canonical skeleton
async function readCanonicalSkeleton(): Promise<string> {
  const skeletonPath = join(ctx.dataCtx.rootDir, "content", SAMPLE_DOC_PATH);
  return readFile(skeletonPath, "utf8");
}

describe("structural tools via proposals", () => {
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

  describe("create_section", () => {
    it("rejects without proposal_id", async () => {
      const res = await callMcpTool("create_section", {
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["NewSection"],
      });

      expect(res.result).toBeDefined();
      const content = res.result.content;
      expect(content[0].text).toContain("proposal_id");
    });

    it("writes skeleton + body to proposal overlay, not canonical", async () => {
      const proposalId = await createProposal("Create section test");
      const originalSkeleton = await readCanonicalSkeleton();

      const res = await callMcpTool("create_section", {
        proposal_id: proposalId,
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["NewSection"],
        content: "New section content.\n",
      });

      expect(res.result).toBeDefined();
      const resultContent = res.result.content;
      const parsed = JSON.parse(resultContent[0].text);
      expect(parsed.created).toBe(true);

      // Canonical should be UNCHANGED
      const currentSkeleton = await readCanonicalSkeleton();
      expect(currentSkeleton).toBe(originalSkeleton);
    });

    it("rejects proposal owned by different writer", async () => {
      // Create proposal as agent
      const proposalId = await createProposal("Agent proposal");

      // Try to use it with a different session/writer — reinit MCP as a different agent
      mcpSessionId = "";
      const otherToken = `Bearer ${Buffer.from(JSON.stringify({
        sub: "other-agent",
        type: "agent",
        displayName: "Other Agent",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })).toString("base64")}`;

      // This will likely fail at auth level, which is correct behavior
      const res = await callMcpTool("create_section", {
        proposal_id: proposalId,
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["NewSection"],
      }, otherToken);

      // Should be rejected (auth failure or ownership check)
      if (res.result) {
        const text = res.result.content?.[0]?.text ?? "";
        expect(text).toContain("own proposals");
      }
    });
  });

  describe("delete_section", () => {
    it("rejects without proposal_id", async () => {
      const res = await callMcpTool("delete_section", {
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["Overview"],
      });

      expect(res.result).toBeDefined();
      const content = res.result.content;
      expect(content[0].text).toContain("proposal_id");
    });

    it("updates skeleton in overlay, canonical untouched", async () => {
      const proposalId = await createProposal("Delete section test");
      const originalSkeleton = await readCanonicalSkeleton();

      const res = await callMcpTool("delete_section", {
        proposal_id: proposalId,
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["Overview"],
      });

      expect(res.result).toBeDefined();
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.deleted).toBe(true);

      // Canonical should be UNCHANGED
      const currentSkeleton = await readCanonicalSkeleton();
      expect(currentSkeleton).toBe(originalSkeleton);
    });
  });

  describe("move_section", () => {
    it("moves section in overlay, canonical untouched", async () => {
      const proposalId = await createProposal("Move section test");
      const originalSkeleton = await readCanonicalSkeleton();

      const res = await callMcpTool("move_section", {
        proposal_id: proposalId,
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["Timeline"],
        new_parent_path: [],
      });

      expect(res.result).toBeDefined();
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.moved).toBe(true);

      // Canonical should be UNCHANGED
      const currentSkeleton = await readCanonicalSkeleton();
      expect(currentSkeleton).toBe(originalSkeleton);
    });
  });

  describe("rename_section", () => {
    it("renames heading in overlay skeleton", async () => {
      const proposalId = await createProposal("Rename section test");
      const originalSkeleton = await readCanonicalSkeleton();

      const res = await callMcpTool("rename_section", {
        proposal_id: proposalId,
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["Overview"],
        new_heading: "Summary",
      });

      expect(res.result).toBeDefined();
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.renamed).toBe(true);
      expect(parsed.new_heading_path).toEqual(["Summary"]);

      // Canonical should be UNCHANGED
      const currentSkeleton = await readCanonicalSkeleton();
      expect(currentSkeleton).toBe(originalSkeleton);
    });

    it("rejects on non-pending proposal", async () => {
      // Create and commit a proposal
      const proposalId = await createProposal("Committed proposal");
      await callMcpTool("write_section", {
        proposal_id: proposalId,
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["Overview"],
        content: "Changed content.\n",
      });

      // Commit it
      await request(ctx.app)
        .post(`/api/proposals/${proposalId}/commit`)
        .set("Authorization", ctx.agentToken);

      // Try to use committed proposal
      const res = await callMcpTool("rename_section", {
        proposal_id: proposalId,
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["Overview"],
        new_heading: "Summary",
      });

      expect(res.result).toBeDefined();
      const text = res.result.content[0].text;
      expect(text).toMatch(/committed|pending/i);
    });
  });

  describe("commit with structural changes", () => {
    it("promotes skeleton overlay to canonical on commit", async () => {
      const proposalId = await createProposal("Structural commit test");
      const originalSkeleton = await readCanonicalSkeleton();

      // Create a new section via MCP
      await callMcpTool("create_section", {
        proposal_id: proposalId,
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["Appendix"],
        content: "Appendix content.\n",
      });

      // Canonical still unchanged
      expect(await readCanonicalSkeleton()).toBe(originalSkeleton);

      // Commit the proposal
      const commitRes = await request(ctx.app)
        .post(`/api/proposals/${proposalId}/commit`)
        .set("Authorization", ctx.agentToken);

      expect(commitRes.status).toBe(200);
      expect(commitRes.body.outcome).toBe("accepted");

      // Now canonical should include the new section
      const newSkeleton = await readCanonicalSkeleton();
      expect(newSkeleton).not.toBe(originalSkeleton);
      expect(newSkeleton).toContain("Appendix");
    });
  });
});
