/**
 * Spec 01 / 05 / 09: when ANY proposal commits, its canonical delta is applied
 * into any open live Y.Doc (the same overlay rule: a live `inprogress` owns
 * only its claimed sections; unclaimed sections inherit current canonical).
 *
 * The existing MW-3 tests (`live-session-wiring`, `external-commit-updates-live-session`)
 * call `applyCommittedCanonicalToLiveSession` themselves after absorb. That
 * proves the helper. It does NOT prove that agent `publish_proposal` runs it.
 *
 * This file goes through the real MCP `create_proposal` → `publish_proposal`
 * pipeline with a live DocSession already open, and NEVER calls the helper.
 * RED until `publish_proposal` pushes the committed canonical change into the
 * open session the same way REST commit and `write_file` already do.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  createSampleDocument,
  SAMPLE_DOC_PATH,
  SAMPLE_SECTIONS,
} from "../helpers/sample-content.js";
import {
  acquireDocSession,
  destroyAllSessions,
} from "../../crdt/ydoc-lifecycle.js";
import { buildFragmentContent } from "../../storage/section-formatting.js";
import type { SectionBody } from "../../storage/section-formatting.js";
import { getHeadSha } from "../../storage/git-repo.js";
import { getDataRoot } from "../../storage/data-root.js";

const HUMAN = { id: "user-alice", type: "human" as const, displayName: "Alice" };
const OVERVIEW_KEY = "section::overview";
const TIMELINE_KEY = "section::timeline";
const AGENT_OVERVIEW = "AGENT COMMITTED OVERVIEW VIA PUBLISH_PROPOSAL";
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

describe("MCP publish_proposal updates an open live Y.Doc", () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterEach(async () => {
    destroyAllSessions();
    await ctx.cleanup();
  });

  it("inherits an agent publish of an unclaimed section into the open live session", async () => {
    const session = await acquireDocSession(
      SAMPLE_DOC_PATH,
      HUMAN.id,
      await getHeadSha(getDataRoot()),
      HUMAN,
      "sock-alice",
    );

    // Alice has claimed Timeline only. Overview stays inherited from canonical,
    // so an external agent commit of Overview MUST flow into this Y.Doc.
    session.liveFragments.replaceFragmentString(
      TIMELINE_KEY,
      buildFragmentContent(ALICE_TIMELINE as SectionBody, 2, "Timeline"),
    );
    session.fragmentLastActivity.set(TIMELINE_KEY, Date.now());
    await session.generator.materializeEdit({ touchedFragmentKeys: [TIMELINE_KEY] });

    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string).toContain(
      SAMPLE_SECTIONS.overview,
    );

    const mcpSessionId = await initMcpSession(ctx);
    const createRes = await callMcpTool(ctx, mcpSessionId, "create_proposal", {
      intent: "update overview from agent",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: `${AGENT_OVERVIEW}\n`,
        },
      ],
    });
    expect(createRes.body.error, JSON.stringify(createRes.body)).toBeUndefined();
    const createData = parseToolJson(createRes.body);
    expect(createData.proposal_id).toBeTruthy();

    const publishRes = await callMcpTool(
      ctx,
      createRes.sessionId,
      "publish_proposal",
      { proposal_id: createData.proposal_id },
    );
    expect(publishRes.body.error, JSON.stringify(publishRes.body)).toBeUndefined();
    const publishData = parseToolJson(publishRes.body);
    expect(publishData.status).toBe("committed");

    // The inherit step enqueues on the DocSession actor lane. Drain it. If
    // publish_proposal never enqueued anything, this is a no-op and Overview
    // stays at the pre-commit canonical body — which is the bug.
    await session.enqueue(() => undefined);

    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string).toContain(AGENT_OVERVIEW);
    expect(session.liveFragments.readFragmentString(OVERVIEW_KEY) as string).not.toContain(
      SAMPLE_SECTIONS.overview,
    );
    expect(session.liveFragments.readFragmentString(TIMELINE_KEY) as string).toContain(ALICE_TIMELINE);
  });
});
