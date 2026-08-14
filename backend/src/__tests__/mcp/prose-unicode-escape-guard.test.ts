/**
 * Canary for the agent-surface prose-escape guard.
 *
 * A `\uXXXX` sequence in PROSE is refused before anything is created or stored.
 * The same sequence inside inline code or a fenced code block is legal and must
 * reach canonical storage byte-for-byte — that is the documented way for an
 * agent to write ABOUT an escape sequence, and there is no bypass flag.
 *
 * The discrimination rests on the Milkdown/remark structure the write path
 * already normalizes through (the `inlineCode` mark and the `code_block` node).
 * A serializer bump that changes that structure would silently turn the guard
 * into a blanket refusal or a no-op; this test is the alarm for that.
 *
 * Read-back goes through `GET /api/canonical/...` rather than an MCP read tool,
 * so this file is independent of the agent read-result shape.
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
): Promise<{ result?: any; error?: any }> {
  const headers: Record<string, string> = {
    Authorization: ctx.agentToken,
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
    .set("Authorization", ctx.agentToken)
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

  if (res.headers["mcp-session-id"]) mcpSessionId = res.headers["mcp-session-id"];
}

async function readCanonicalMarkdown(): Promise<string> {
  const res = await request(ctx.app)
    .get(`/api/canonical/${SAMPLE_DOC_PATH.replace(/^\//, "")}`)
    .set("Authorization", ctx.humanToken);
  expect(res.status).toBe(200);
  return res.body.content as string;
}

/** Six literal characters: backslash, u, 2, 0, 1, 3 — NOT an en-dash. */
const ESCAPE_TOKEN = "\\u2013";

describe("prose \\uXXXX escapes on the agent write surface", () => {
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

  it("refuses an escape sequence in prose, quotes it back, and leaves no draft behind", async () => {
    const res = await callMcpTool("create_proposal", {
      intent: "Escape sequence in prose",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: `Sessions run 02${ESCAPE_TOKEN}09 each year.`,
        },
      ],
    });

    const data = JSON.parse(res.result.content[0].text);
    expect(data.outcome).toBe("blocked");
    expect(data.message).toContain(ESCAPE_TOKEN);
    expect(data.proposal_id).toBeUndefined();

    // The refusal happens before the proposal is created: no orphan draft.
    const drafts = await callMcpTool("my_proposals", { status: "draft" });
    expect(JSON.parse(drafts.result.content[0].text).proposals).toEqual([]);

    // Nothing reached canonical storage.
    expect(await readCanonicalMarkdown()).not.toContain(ESCAPE_TOKEN);
  });

  it("accepts the same sequence inside inline code and a fenced block, storing it verbatim", async () => {
    const content = [
      `A broken client sends the token \`${ESCAPE_TOKEN}\` instead of an en-dash.`,
      "",
      "```json",
      `{ "content": "02${ESCAPE_TOKEN}09" }`,
      "```",
    ].join("\n");

    const createRes = await callMcpTool("create_proposal", {
      intent: "Document the escape sequence in code",
      sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content }],
    });
    const created = JSON.parse(createRes.result.content[0].text);
    expect(created.outcome).toBe("accepted");

    const publishRes = await callMcpTool("publish_proposal", {
      proposal_id: created.proposal_id,
    });
    expect(JSON.parse(publishRes.result.content[0].text).status).toBe("committed");

    const stored = await readCanonicalMarkdown();
    expect(stored).toContain(`\`${ESCAPE_TOKEN}\``);
    expect(stored).toContain(`{ "content": "02${ESCAPE_TOKEN}09" }`);
  });
});
