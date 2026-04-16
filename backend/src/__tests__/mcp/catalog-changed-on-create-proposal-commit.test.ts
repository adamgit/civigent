/**
 * Integration test — the full create_proposal + commit_proposal MCP pipeline
 * must emit exactly one `catalog:changed` WS event whose `added_doc_paths`
 * includes the brand-new doc path. Exercised on each agent-capable MCP mount.
 *
 * Diagnoses "MCP-created documents don't appear in sidebar tree" end-to-end:
 * the unit test (catalog-events-created-docs.test.ts) proves the summarizer is
 * correct in isolation, so if this integration test fails, the break is in
 * the event-emission wiring — either `ctx.emitEvent` is undefined / stale,
 * or the commit handler is dropping the event before it reaches the hub.
 *
 * Per the task spec we repeat the scenario on:
 *   - /mcp/tier3          — the explicit tier-3 mount
 *   - /mcp (auto-detect)  — with Claude user-agent so it routes to tier-3
 *
 * /mcp/tier1 and /mcp/tier2 do not expose create_proposal / commit_proposal,
 * so they are out of scope for this integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import type { WsServerEvent } from "../../types/shared.js";

interface McpCallOptions {
  mount: string;
  userAgent?: string;
}

async function initMcpSession(
  ctx: TestServerContext,
  opts: McpCallOptions,
): Promise<string> {
  let req = request(ctx.app)
    .post(opts.mount)
    .set("Authorization", ctx.agentToken)
    .set("Content-Type", "application/json");
  if (opts.userAgent) {
    req = req.set("User-Agent", opts.userAgent);
  }
  const res = await req.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    },
  });
  return (res.headers["mcp-session-id"] as string) ?? "";
}

async function callMcpTool(
  ctx: TestServerContext,
  opts: McpCallOptions,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ body: { result?: { content: Array<{ text: string }> }; error?: unknown }; sessionId: string }> {
  const headers: Record<string, string> = {
    Authorization: ctx.agentToken,
    "Content-Type": "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (opts.userAgent) headers["User-Agent"] = opts.userAgent;

  const res = await request(ctx.app)
    .post(opts.mount)
    .set(headers)
    .send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });

  return {
    body: res.body,
    sessionId: (res.headers["mcp-session-id"] as string) ?? sessionId,
  };
}

const MOUNTS: Array<{ label: string; opts: McpCallOptions }> = [
  { label: "/mcp/tier3", opts: { mount: "/mcp/tier3" } },
  { label: "/mcp (auto-detect, claude UA)", opts: { mount: "/mcp", userAgent: "claude-code/1.0" } },
];

describe("MCP create_proposal+commit_proposal emits catalog:changed for new doc", () => {
  for (const { label, opts } of MOUNTS) {
    describe(label, () => {
      let ctx: TestServerContext;

      beforeEach(async () => {
        ctx = await createTestServer();
      });

      afterEach(async () => {
        await ctx.cleanup();
      });

      it("emits exactly one catalog:changed with the new doc_path in added_doc_paths", async () => {
        const newDocPath = `/ops/agent-new-doc-${Date.now()}.md`;
        const sessionId = await initMcpSession(ctx, opts);

        const createRes = await callMcpTool(ctx, opts, sessionId, "create_proposal", {
          intent: "create a brand new doc",
          sections: [
            {
              doc_path: newDocPath,
              heading_path: ["Summary"],
              content: "Agent-authored summary.",
            },
          ],
        });
        expect(createRes.body.error, JSON.stringify(createRes.body)).toBeUndefined();
        const createData = JSON.parse(createRes.body.result!.content[0]!.text);
        expect(createData.proposal_id).toBeTruthy();

        // Clear wsEvents we don't care about (proposal:draft) so the catalog
        // assertion is narrowly scoped to the commit step.
        ctx.wsEvents.length = 0;

        const commitRes = await callMcpTool(
          ctx,
          opts,
          createRes.sessionId,
          "commit_proposal",
          { proposal_id: createData.proposal_id },
        );
        expect(commitRes.body.error, JSON.stringify(commitRes.body)).toBeUndefined();
        const commitData = JSON.parse(commitRes.body.result!.content[0]!.text);
        expect(commitData.status).toBe("committed");

        const catalogEvents = ctx.wsEvents.filter(
          (event): event is Extract<WsServerEvent, { type: "catalog:changed" }> =>
            event.type === "catalog:changed",
        );

        expect(catalogEvents.length).toBe(1);
        expect(catalogEvents[0].added_doc_paths).toContain(newDocPath);
        expect(catalogEvents[0].removed_doc_paths).toEqual([]);
        expect(catalogEvents[0].writer_type).toBe("agent");
      });
    });
  }
});
