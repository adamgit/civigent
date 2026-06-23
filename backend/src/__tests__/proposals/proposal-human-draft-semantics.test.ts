/**
 * Human draft creation semantics (spec 02 §3 Invariants 1, 3, 6).
 *
 *  - A human proposal is created as `draft` and bypasses Agent Write Policy.
 *  - An EMPTY intent is accepted at creation for humans (unlike agents, where a
 *    non-empty intent is required), but a non-empty intent IS required
 *    (effective) before lock acquisition (`draft -> inprogress`). (The wire
 *    schema requires the `intent` key to be present as a string for everyone;
 *    the human relaxation is that it may be empty.)
 *  - Humans may hold MULTIPLE simultaneous `draft` proposals — the single-draft
 *    409 invariant does not apply to them.
 *
 * The existing `proposal-create.test.ts` covers the AGENT create path; this file
 * pins the human-specific semantics. Do not weaken these to legacy single-draft
 * behaviour.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

describe("human draft creation semantics (spec 02 §3 Invariants)", () => {
  let ctx: TestServerContext;
  let prevAuthMode: string | undefined;

  beforeAll(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("creates a human proposal as draft and bypasses Agent Write Policy", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Human revises the overview",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Human overview.\n" }],
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.outcome).toBe("accepted");
    // Human bypass: policy admits without HI evaluation.
    expect(res.body.agentWritePolicy.canWrite).toBe(true);
  });

  it("accepts an empty intent at creation for humans (agents do not)", async () => {
    const humanRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Empty-intent human draft.\n" }],
      });
    expect(humanRes.status).toBe(201);
    expect(humanRes.body.status).toBe("draft");

    // The same empty intent for an agent is a 400 (intent required) — proving the
    // human-specific relaxation, not a global one.
    const agentRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", authFor("intent-check-agent", "agent"))
      .send({
        intent: "",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "x\n" }],
      });
    expect(agentRes.status).toBe(400);
  });

  it("requires effective intent before lock acquisition (draft -> inprogress)", async () => {
    // Human draft with a real target but an empty intent.
    const create = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "Timeline draft.\n" }],
      });
    expect(create.status).toBe(201);
    const proposalId = create.body.proposal_id;

    // Acquire-locks is refused while intent is empty.
    const blocked = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/acquire-locks`)
      .set("Authorization", ctx.humanToken);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error ?? blocked.text).toMatch(/intent is required/i);

    // Set intent via the manifest PUT, keeping the same target scope.
    const setIntent = await request(ctx.app)
      .put(`/api/proposals/${proposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Tighten the timeline",
        targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] }],
      });
    expect(setIntent.status).toBe(200);

    // Now lock acquisition succeeds and the proposal enters inprogress.
    const acquired = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/acquire-locks`)
      .set("Authorization", ctx.humanToken);
    expect(acquired.status).toBe(200);
    expect(acquired.body.acquired).toBe(true);
    expect(acquired.body.status).toBe("inprogress");
  });

  it("allows multiple simultaneous human drafts (no single-draft 409)", async () => {
    const writer = authFor("multi-draft-human", "human");

    const first = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writer)
      .send({ intent: "First human draft", sections: [] });
    const second = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writer)
      .send({ intent: "Second human draft", sections: [] });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.status).toBe("draft");
    expect(second.body.status).toBe("draft");
    expect(second.body.proposal_id).not.toBe(first.body.proposal_id);

    // Both are visible as this writer's drafts simultaneously.
    const mine = await request(ctx.app)
      .get("/api/my-proposals?status=draft")
      .set("Authorization", writer);
    expect(mine.status).toBe(200);
    const ids = mine.body.proposals.map((p: { id: string }) => p.id);
    expect(ids).toContain(first.body.proposal_id);
    expect(ids).toContain(second.body.proposal_id);
  });
});
