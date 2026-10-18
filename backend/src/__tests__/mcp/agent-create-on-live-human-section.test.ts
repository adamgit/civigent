/**
 * Spec 04 §APIs (agent `POST /api/proposals` carries a target-level Agent Write
 * Policy evaluation), 04 §Decision mechanisms (a section in live human CRDT work
 * is fully contested), and 13 §Compatibility policy (time since human activity
 * includes CRDT content activity, not only the last human git commit).
 *
 * A human has unpublished live edits on Timeline — a DocSession `inprogress`
 * proposal holds it, and there is no recent human git commit. An agent that
 * creates a proposal on Timeline must be told it is contested at creation
 * (still receiving a draft it can keep), not only when it later publishes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { acquireDocSession, destroyAllSessions } from "../../crdt/ydoc-lifecycle.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const HUMAN = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const TIMELINE_KEY = "section::timeline";
const ALICE_TIMELINE = "alice's local unpublished timeline";

async function initMcpSession(ctx: TestServerContext): Promise<string> {
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
  return (res.headers["mcp-session-id"] as string) ?? "";
}

async function callMcpTool(
  ctx: TestServerContext,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ body: { result?: { content: Array<{ text: string }> }; error?: unknown }; sessionId: string }> {
  const headers: Record<string, string> = {
    Authorization: ctx.agentToken,
    "Content-Type": "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await request(ctx.app)
    .post("/mcp/tier3")
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

function parseToolJson(body: { result?: { content: Array<{ text: string }> } }): Record<string, unknown> {
  const text = body.result?.content[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`MCP tool result missing text: ${JSON.stringify(body)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe("agent create_proposal on a section a human is live-editing", () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("reports the section as contested at creation, not only at publish", async () => {
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      HUMAN.id,
      await getHeadSha(getDataRoot()),
      HUMAN,
      "sock-alice",
    );
    session.liveFragments.replaceFragmentString(
      TIMELINE_KEY,
      buildFragmentContent(ALICE_TIMELINE as SectionBody, 2, "Timeline"),
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });

    const mcpSessionId = await initMcpSession(ctx);
    const createRes = await callMcpTool(ctx, mcpSessionId, "create_proposal", {
      intent: "agent rewrites timeline",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Timeline"],
          content: "Agent timeline.\n",
        },
      ],
    });
    expect(createRes.body.error, JSON.stringify(createRes.body)).toBeUndefined();
    const createData = parseToolJson(createRes.body);

    expect(createData.proposal_id).toBeTruthy();
    expect(createData.status).toBe("draft");
    expect(createData.outcome, JSON.stringify(createData)).toBe("blocked");

    const publishRes = await callMcpTool(ctx, createRes.sessionId, "publish_proposal", {
      proposal_id: createData.proposal_id,
    });
    expect(publishRes.body.error, JSON.stringify(publishRes.body)).toBeUndefined();
    const publishData = parseToolJson(publishRes.body);
    expect(publishData.outcome).toBe("blocked");
    expect(publishData.status).not.toBe("committed");
  });
});
