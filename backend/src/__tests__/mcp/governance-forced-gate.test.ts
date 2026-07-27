/**
 * Governance mode `forced` — MCP call-time gate.
 *
 * When `getAdminConfig().governance_mode === "forced"`, every Tier 1 and Tier 2
 * tool invocation (reads and writes alike) must fail BEFORE its handler runs, with
 * a clear MCP tool error (no error code) directing the agent to the Tier 3 explicit
 * proposal-management workflow. Tier 3 tools are never gated. The mode is read at
 * call time, so toggling `KS_GOVERNANCE_MODE` affects new calls with no restart.
 *
 * These tests drive the real HTTP MCP endpoints and assert:
 *   - forced: a Tier 1 write and a Tier 2 write both return the governance error
 *     and perform NO write (the doc never appears once the mode is relaxed),
 *   - forced: a Tier 1 read also returns the governance error (reads are gated too),
 *   - forced: the `/mcp` UA-fallback (resolves to Tier 1) is gated as well,
 *   - forced: a Tier 3 tool still works,
 *   - available: the same Tier 1 / Tier 2 tools succeed and Tier 3 is unaffected.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { authFor } from "../helpers/auth.js";

let ctx: TestServerContext;
let tier1SessionId = "";
let tier2SessionId = "";
let tier3SessionId = "";
let autoSessionId = "";

const AGENT_ID = "governance-agent";
const agentToken = authFor(AGENT_ID, "agent");

const FORCED_DOC_PATH = "/governance/forced-doc.md";

const GOVERNANCE_ENV = "KS_GOVERNANCE_MODE";
let savedGovernanceMode: string | undefined;

type McpEndpoint = "/mcp/tier1" | "/mcp/tier2" | "/mcp/tier3" | "/mcp";

async function callMcpTool(
  endpoint: McpEndpoint,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ body: any; sessionId: string }> {
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
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });

  return { body: res.body, sessionId: res.headers["mcp-session-id"] ?? sessionId };
}

async function initMcpSession(endpoint: McpEndpoint): Promise<string> {
  const res = await request(ctx.app)
    .post(endpoint)
    .set("Authorization", agentToken)
    .set("Content-Type", "application/json")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gov", version: "1.0" } },
    });
  return res.headers["mcp-session-id"] ?? "";
}

function setGovernanceMode(mode: "forced" | "available"): void {
  process.env[GOVERNANCE_ENV] = mode;
}

function resultText(body: any): string {
  return body.result.content[0].text as string;
}

function expectGovernanceError(body: any): void {
  expect(body.result.isError).toBe(true);
  const text = resultText(body);
  expect(text).toContain("forced");
  expect(text).toContain("/mcp/tier3");
  expect(text).toContain("create_proposal");
  expect(text).toContain("publish_proposal");
}

describe("Governance mode `forced` — MCP call-time gate", () => {
  beforeAll(async () => {
    savedGovernanceMode = process.env[GOVERNANCE_ENV];
    ctx = await createTestServer();
    tier1SessionId = await initMcpSession("/mcp/tier1");
    tier2SessionId = await initMcpSession("/mcp/tier2");
    tier3SessionId = await initMcpSession("/mcp/tier3");
    autoSessionId = await initMcpSession("/mcp");
  });

  afterAll(async () => {
    if (savedGovernanceMode === undefined) delete process.env[GOVERNANCE_ENV];
    else process.env[GOVERNANCE_ENV] = savedGovernanceMode;
    await ctx.cleanup();
  });

  it("forced: a Tier 1 write_file is rejected and writes nothing", async () => {
    setGovernanceMode("forced");
    const res = await callMcpTool("/mcp/tier1", tier1SessionId, "write_file", {
      path: FORCED_DOC_PATH,
      content: "# Forced\n\nShould never be written.\n",
    });
    expectGovernanceError(res.body);
  });

  it("forced: a Tier 1 read_file is rejected (reads are gated too)", async () => {
    setGovernanceMode("forced");
    const res = await callMcpTool("/mcp/tier1", tier1SessionId, "read_file", {
      path: FORCED_DOC_PATH,
    });
    expectGovernanceError(res.body);
  });

  it("forced: a Tier 2 plan_changes and write_file are both rejected", async () => {
    setGovernanceMode("forced");
    const planRes = await callMcpTool("/mcp/tier2", tier2SessionId, "plan_changes", {
      description: "should be blocked",
    });
    expectGovernanceError(planRes.body);

    const writeRes = await callMcpTool("/mcp/tier2", tier2SessionId, "write_file", {
      path: FORCED_DOC_PATH,
      content: "# Forced via tier2\n",
    });
    expectGovernanceError(writeRes.body);
  });

  it("forced: the /mcp UA-fallback (resolves to Tier 1) is also gated", async () => {
    setGovernanceMode("forced");
    const res = await callMcpTool("/mcp", autoSessionId, "write_file", {
      path: FORCED_DOC_PATH,
      content: "# Forced via auto-detect\n",
    });
    expectGovernanceError(res.body);
  });

  it("forced: a Tier 3 tool is unaffected", async () => {
    setGovernanceMode("forced");
    const res = await callMcpTool("/mcp/tier3", tier3SessionId, "list_documents", {});
    expect(res.body.result.isError).toBeFalsy();
  });

  it("available: the Tier 1 write that was rejected under forced never happened", async () => {
    // Switch to available, then read the doc the forced writes targeted: it must be
    // absent, proving the gate rejected before any write occurred.
    setGovernanceMode("available");
    const res = await callMcpTool("/mcp/tier1", tier1SessionId, "read_file", {
      path: FORCED_DOC_PATH,
    });
    expect(res.body.result.isError).toBe(true);
    expect(resultText(res.body)).toContain("Document not found");
  });

  it("available: Tier 1 write_file + read_file succeed", async () => {
    setGovernanceMode("available");
    const writeRes = await callMcpTool("/mcp/tier1", tier1SessionId, "write_file", {
      path: FORCED_DOC_PATH,
      content: "# Now allowed\n\nWritten under available mode.\n",
    });
    expect(writeRes.body.result.isError).toBeFalsy();

    const readRes = await callMcpTool("/mcp/tier1", tier1SessionId, "read_file", {
      path: FORCED_DOC_PATH,
    });
    expect(readRes.body.result.isError).toBeFalsy();
    expect(resultText(readRes.body)).toContain("Now allowed");
  });

  it("available: a Tier 2 plan_changes succeeds", async () => {
    setGovernanceMode("available");
    const res = await callMcpTool("/mcp/tier2", tier2SessionId, "plan_changes", {
      description: "allowed intent",
    });
    expect(res.body.result.isError).toBeFalsy();
  });

  it("available: a Tier 3 tool is unaffected", async () => {
    setGovernanceMode("available");
    const res = await callMcpTool("/mcp/tier3", tier3SessionId, "list_documents", {});
    expect(res.body.result.isError).toBeFalsy();
  });
});
