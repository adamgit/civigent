/**
 * Session-local draft isolation — parallel MCP sessions under one agent
 * credential.
 *
 * Locks the endemic bug class: two MCP conversations under one agent token must
 * not clobber each other's drafts, and a session-id string reused across writers
 * must not share in-memory session state. The affinity lives ONLY in the
 * in-memory `McpSession` object (task 708) — proposals persist no session
 * identity, and explicit `proposal_id` publish/withdraw still crosses sessions
 * for the SAME writer (affinity ≠ authorization).
 *
 * Sessions are driven by presenting explicit `Mcp-Session-Id` headers; the
 * transport adopts them (no initialize handshake is required for tools/call).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

let ctx: TestServerContext;

async function call(
  token: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await request(ctx.app)
    .post("/mcp/tier3")
    .set({ Authorization: token, "Content-Type": "application/json", "Mcp-Session-Id": sessionId })
    .send({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: args } });
  return res.body;
}

/** Parse the JSON payload of a successful tool result. */
function ok(body: any): any {
  return JSON.parse(body.result.content[0].text);
}

function overview(content: string) {
  return { sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content }] };
}
function timeline(content: string) {
  return { sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content }] };
}

describe("parallel MCP sessions under one agent credential", () => {
  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  const agent = authFor("parallel-agent", "agent");

  it("session B replace does NOT withdraw session A's draft (same writer)", async () => {
    const pA = ok(await call(agent, "sess-A", "create_proposal", { intent: "A draft", ...overview("A body.\n") })).proposal_id;
    const pB = ok(await call(agent, "sess-B", "create_proposal", { intent: "B draft", ...timeline("B body.\n") })).proposal_id;

    // B's replace withdraws ONLY B's own draft (session-local memory).
    const b2 = ok(await call(agent, "sess-B", "create_proposal", { intent: "B replace", replace: true, ...timeline("B2 body.\n") }));
    expect(b2.withdrawn_proposal_id).toBe(pB);
    expect(b2.proposal_id).not.toBe(pB);

    // A's draft is untouched — still a draft.
    const rA = ok(await call(agent, "sess-A", "read_proposal", { proposal_id: pA }));
    expect(rA.proposal.status).toBe("draft");
  });

  it("my_proposals is writer-scoped: drafts survive session boundaries", async () => {
    const pA = ok(await call(agent, "list-A", "create_proposal", { intent: "list A", ...overview("la.\n") })).proposal_id;
    const pB = ok(await call(agent, "list-B", "create_proposal", { intent: "list B", ...timeline("lb.\n") })).proposal_id;

    // my_proposals lists everything the WRITER authored — proposals carry no
    // session identity, so both sessions (and any future session under the same
    // credential) see both drafts. Isolation applies to implicit auto-withdraw,
    // not to visibility of your own durable proposals.
    const idsA = ok(await call(agent, "list-A", "my_proposals", { status: "draft" })).proposals.map((p: any) => p.id);
    const idsB = ok(await call(agent, "list-B", "my_proposals", { status: "draft" })).proposals.map((p: any) => p.id);

    expect(idsA).toContain(pA);
    expect(idsA).toContain(pB);
    expect(idsB).toContain(pA);
    expect(idsB).toContain(pB);

    // No persisted session identity on any proposal.
    const rA = ok(await call(agent, "list-B", "read_proposal", { proposal_id: pA }));
    expect(rA.proposal.agent_session_id).toBeUndefined();
  });

  it("same presented session id keeps affinity: replace targets the session's most recent draft", async () => {
    const c1 = ok(await call(agent, "cust-X", "create_proposal", { intent: "cx1", ...overview("cx1.\n") })).proposal_id;
    const c2 = ok(await call(agent, "cust-X", "create_proposal", { intent: "cx2", ...timeline("cx2.\n") })).proposal_id;

    // replace under the same presented id withdraws the session's MOST RECENT
    // draft (c2), never a draft from another session.
    const c3 = ok(await call(agent, "cust-X", "create_proposal", { intent: "cx3", replace: true, ...timeline("cx3.\n") }));
    expect(c3.withdrawn_proposal_id).toBe(c2);

    const r1 = ok(await call(agent, "cust-X", "read_proposal", { proposal_id: c1 }));
    expect(r1.proposal.status).toBe("draft");
  });

  it("two different writers presenting the same session id string are isolated", async () => {
    const alpha = authFor("writer-alpha", "agent");
    const beta = authFor("writer-beta", "agent");
    const SHARED = "shared-session-string";

    const pAlpha = ok(await call(alpha, SHARED, "create_proposal", { intent: "alpha", ...overview("alpha.\n") })).proposal_id;
    const pBeta = ok(await call(beta, SHARED, "create_proposal", { intent: "beta", ...timeline("beta.\n") })).proposal_id;

    // Beta's replace under the shared id string withdraws only Beta's own draft.
    const beta2 = ok(await call(beta, SHARED, "create_proposal", { intent: "beta replace", replace: true, ...timeline("beta2.\n") }));
    expect(beta2.withdrawn_proposal_id).toBe(pBeta);

    // Alpha's draft is untouched despite sharing the session-id string.
    const rAlpha = ok(await call(alpha, SHARED, "read_proposal", { proposal_id: pAlpha }));
    expect(rAlpha.proposal.status).toBe("draft");

    // Alpha's my_proposals (writer-scoped) never lists Beta's proposals.
    const alphaIds = ok(await call(alpha, SHARED, "my_proposals", { status: "draft" })).proposals.map((p: any) => p.id);
    expect(alphaIds).toContain(pAlpha);
    expect(alphaIds).not.toContain(pBeta);
  });

  it("session DELETE loses the implicit affinity but never the proposals", async () => {
    const pD = ok(await call(agent, "del-sess", "create_proposal", { intent: "pre-delete draft", ...overview("pd.\n") })).proposal_id;

    // Tear down the session: drops in-memory state only, never proposals.
    await request(ctx.app)
      .delete("/mcp/tier3")
      .set({ Authorization: agent, "Mcp-Session-Id": "del-sess" });

    // Same presented id after teardown → fresh empty memory: replace has no
    // remembered draft to withdraw (no recovery persistence recreates affinity).
    const after = ok(await call(agent, "del-sess", "create_proposal", { intent: "post-delete replace", replace: true, ...timeline("pd2.\n") }));
    expect(after.withdrawn_proposal_id).toBeUndefined();

    // The pre-teardown draft survives and stays reachable by explicit id.
    const rD = ok(await call(agent, "del-sess", "read_proposal", { proposal_id: pD }));
    expect(rD.proposal.status).toBe("draft");
    const wd = ok(await call(agent, "del-sess", "withdraw_proposal", { proposal_id: pD }));
    expect(wd.status).toBe("withdrawn");
  });

  it("explicit publish by id works from a different session of the same writer", async () => {
    const pubId = ok(await call(agent, "make-sess", "create_proposal", { intent: "to publish", ...overview("pub body.\n") })).proposal_id;

    // Publish from a DIFFERENT session of the same writer — writer-only auth, no
    // session gate on explicit-id paths.
    const pub = ok(await call(agent, "other-sess", "publish_proposal", { proposal_id: pubId }));
    expect(pub.status).toBe("committed");
  });
});
