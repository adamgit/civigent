/**
 * Area M — MCP blocked-response prose contract.
 *
 * Every blocked/deferred MCP tool result must carry:
 *   - a REQUIRED top-level prose `message` (verbose, action-oriented), and
 *   - per-target prose `message`s (one per declined target),
 * and must NOT carry any bare reason-code / threshold / enum-as-explanation
 * field (`block_reason`, `blocked_reason`, `per_section_threshold`,
 * `aggregate_threshold`, `aggregate_impact`, `humanInvolvement_score`,
 * `blocked_sections`/`passed_sections`). `outcome: "blocked"` may remain, but
 * only as a machine branch flag — never as the explanation.
 *
 * Covers `create_proposal`, `publish_proposal`, and the `write_file` filesystem
 * tool. The block is provoked by very recent human commit activity (the
 * human-involvement compatibility policy declines the agent write).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  createSampleDocument,
  createHumanCommit,
  SAMPLE_DOC_PATH,
} from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import { updateAdminConfig } from "../../admin-config.js";

let ctx: TestServerContext;
let mcpSessionId = "";

const AGENT_ID = "areaM-proseagent";
const agentToken = authFor(AGENT_ID, "agent");

// Field names that must NEVER appear anywhere in a blocked MCP response body —
// these are the retired bare codes / thresholds / enums-as-explanation.
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

function assertNoForbiddenCodeFields(rawText: string): void {
  for (const field of FORBIDDEN_CODE_FIELDS) {
    expect(rawText).not.toContain(`"${field}"`);
  }
}

// create_proposal / publish_proposal live on tier3 (collaboration); write_file
// lives on tier1 (filesystem). Each tier negotiates its own MCP session.
let tier1SessionId = "";

async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  endpoint: "/mcp/tier3" | "/mcp/tier1" = "/mcp/tier3",
): Promise<{ text: string; data: any }> {
  const sessionId = endpoint === "/mcp/tier1" ? tier1SessionId : mcpSessionId;
  const headers: Record<string, string> = {
    Authorization: agentToken,
    "Content-Type": "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await request(ctx.app)
    .post(endpoint)
    .set(headers)
    .send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });

  if (res.headers["mcp-session-id"]) {
    if (endpoint === "/mcp/tier1") tier1SessionId = res.headers["mcp-session-id"];
    else mcpSessionId = res.headers["mcp-session-id"];
  }

  const text: string = res.body.result.content[0].text;
  return { text, data: JSON.parse(text) };
}

async function initMcpSession(endpoint: "/mcp/tier3" | "/mcp/tier1"): Promise<void> {
  const res = await request(ctx.app)
    .post(endpoint)
    .set("Authorization", agentToken)
    .set("Content-Type", "application/json")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "areaM-prose", version: "1.0" },
      },
    });
  if (res.headers["mcp-session-id"]) {
    if (endpoint === "/mcp/tier1") tier1SessionId = res.headers["mcp-session-id"];
    else mcpSessionId = res.headers["mcp-session-id"];
  }
}

/** A blocked MCP body must carry top-level + per-target prose and no codes. */
function assertBlockedProseContract(text: string, data: any): void {
  // Machine branch flag is allowed...
  expect(data.outcome).toBe("blocked");
  // ...but the explanation is a real, non-trivial top-level prose string.
  expect(typeof data.message).toBe("string");
  expect(data.message.length).toBeGreaterThan(20);
  // The top-level prose must not be a bare code/enum token.
  expect(data.message).toMatch(/\s/); // contains whitespace → a sentence, not a code

  // Per-target prose for every declined target.
  const targets = data.agent_write_policy?.targets ?? [];
  expect(targets.length).toBeGreaterThan(0);
  const declined = targets.filter((t: any) => t.can_write === false);
  expect(declined.length).toBeGreaterThan(0);
  for (const t of declined) {
    expect(typeof t.message).toBe("string");
    expect(t.message.length).toBeGreaterThan(20);
  }

  // No bare reason-code / threshold / enum field anywhere in the body.
  assertNoForbiddenCodeFields(text);
}

describe("Area M: MCP blocked responses carry prose, not codes", () => {
  beforeAll(async () => {
    updateAdminConfig({ humanInvolvement_preset: "eager" });
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    // Very recent human edit → high recency score → agent write policy declines.
    await createHumanCommit(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Fresh human-edited overview content.\n",
      0.01, // ~36s ago → score ≈ 1.0
    );
    await initMcpSession("/mcp/tier3");
    await initMcpSession("/mcp/tier1");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("create_proposal blocked response has top-level + per-target prose and no codes", async () => {
    const { text, data } = await callMcpTool("create_proposal", {
      intent: "Rewrite a just-edited section",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "Agent overview rewrite.\n",
        },
      ],
    });

    assertBlockedProseContract(text, data);
  });

  it("publish_proposal blocked response has top-level + per-target prose and no codes", async () => {
    const created = await callMcpTool("create_proposal", {
      intent: "Rewrite a just-edited section (publish path)",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "Agent overview rewrite for publish.\n",
        },
      ],
    });
    // The create itself blocks; publish the still-draft proposal to exercise the
    // publish_proposal blocked branch explicitly.
    const { text, data } = await callMcpTool("publish_proposal", {
      proposal_id: created.data.proposal_id,
    });

    expect(data.status).toBe("draft");
    assertBlockedProseContract(text, data);
  });

  it("write_file blocked response has top-level + per-target prose and no codes", async () => {
    const { text, data } = await callMcpTool("write_file", {
      path: SAMPLE_DOC_PATH,
      content: "# Overview\n\nWholesale agent rewrite of a freshly human-edited doc.\n",
    }, "/mcp/tier1");

    expect(data.success).toBe(false);
    assertBlockedProseContract(text, data);
  });
});
