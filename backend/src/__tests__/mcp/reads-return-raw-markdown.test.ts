/**
 * Canary for the agent read shape: a body read answers WITH the markdown.
 *
 * `read_published_section` must return the section fragment itself, not a JSON
 * envelope around it. The envelope is what shows the model `\n`, `\"`, doubled
 * backslashes, and (under any client-side ensure_ascii printer) `\uXXXX` in
 * place of real punctuation — the loop that teaches an agent to send escape
 * sequences back as markdown.
 *
 * The same test pins character fidelity end to end: real en-dash, em-dash,
 * curly apostrophe, and non-breaking space must survive the write-side
 * remark normalization and come back as the same code points. It goes red if
 * anyone reintroduces an envelope OR adds an encode/unescape step on write.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

/** Real code points: U+2013, U+2014, U+2019, U+00A0 — no escape sequences. */
const PUNCTUATION_BODY =
  "Sessions run 02\u201309 each year \u2014 it\u2019s a non\u00a0breaking space.";

describe("read_published_section returns markdown, not a JSON envelope", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    await request(ctx.app)
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
      })
      .then((res) => {
        if (res.headers["mcp-session-id"]) mcpSessionId = res.headers["mcp-session-id"];
      });

    const createRes = await callMcpTool("create_proposal", {
      intent: "Publish punctuation-bearing prose",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: PUNCTUATION_BODY,
        },
      ],
    });
    const created = JSON.parse(createRes.result.content[0].text);
    const publishRes = await callMcpTool("publish_proposal", {
      proposal_id: created.proposal_id,
    });
    expect(JSON.parse(publishRes.result.content[0].text).status).toBe("committed");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("answers with the section fragment and preserves every code point", async () => {
    const res = await callMcpTool("read_published_section", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
    });

    const text: string = res.result.content[0].text;

    // The result IS markdown: it starts with the heading line and is not JSON.
    expect(text.startsWith("## Overview")).toBe(true);
    expect(() => JSON.parse(text)).toThrow();

    expect(text).toContain(PUNCTUATION_BODY);
    expect(text).not.toContain("\\u2013");
    expect(text).not.toContain("\\n");
  });
});
