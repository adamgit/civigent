import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";

let ctx: TestServerContext;
let mcpSessionId = "";

async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  token: string = ctx.agentToken,
): Promise<{ result?: { content: Array<{ text: string }> }; error?: unknown }> {
  const headers: Record<string, string> = {
    Authorization: token,
    "Content-Type": "application/json",
  };
  if (mcpSessionId) {
    headers["Mcp-Session-Id"] = mcpSessionId;
  }

  const res = await request(ctx.app)
    .post("/mcp/tier1")
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
    .post("/mcp/tier1")
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

describe("MCP write_file attribution", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    mcpSessionId = "";
    await initMcpSession();
  });

  it("shows AI last_editor immediately after creating a nested document with BFH and body-holder sections", async () => {
    const docPath = "/ops/agent-created-attribution.md";
    const content = [
      "Document preamble created by agent.",
      "",
      "## Program",
      "",
      "Program body created by agent.",
      "",
      "### Launch",
      "",
      "Launch body created by agent.",
      "",
      "## Risks",
      "",
      "Risk body created by agent.",
    ].join("\n");

    const writeRes = await callMcpTool("write_file", {
      path: docPath,
      content,
    });
    const writeData = JSON.parse(writeRes.result?.content[0]?.text ?? "{}");
    expect(writeData.success).toBe(true);
    expect(writeData.status).toBe("committed");

    const sectionsRes = await request(ctx.app)
      .get(`/api/documents/${encodeURIComponent(docPath)}/sections`)
      .set("Authorization", ctx.agentToken);

    expect(sectionsRes.status).toBe(200);

    const sections = sectionsRes.body.sections as Array<{
      heading_path: string[];
      last_editor?: { id: string; name: string; type: string };
    }>;
    const byKey = new Map(sections.map((section) => [JSON.stringify(section.heading_path), section]));

    expect(Array.from(byKey.keys())).toEqual([
      JSON.stringify([]),
      JSON.stringify(["Program"]),
      JSON.stringify(["Program", "Launch"]),
      JSON.stringify(["Risks"]),
    ]);

    for (const key of [[], ["Program"], ["Program", "Launch"], ["Risks"]]) {
      const section = byKey.get(JSON.stringify(key));
      expect(section, `Missing section ${JSON.stringify(key)}`).toBeDefined();
      expect(section?.last_editor, `Missing last_editor for ${JSON.stringify(key)}`).toBeDefined();
      expect(section?.last_editor?.id).toBe(ctx.agentId);
      expect(section?.last_editor?.name).toBe(ctx.agentId);
      expect(section?.last_editor?.type).toBe("agent");
    }
  });
});
