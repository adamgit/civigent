import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

describe("POST /api/proposals/:id/cancel — cancel proposal", () => {
  let ctx: TestServerContext;
  let pendingProposalId: string;
  let committedProposalId: string;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Create a human_reservation proposal (stays pending — can be cancelled)
    const pendingRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Human edit for cancel tests",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Human content to cancel.\n",
          },
        ],
      });

    expect(pendingRes.body.status).toBe("draft");
    pendingProposalId = pendingRes.body.proposal_id;

    // Create an agent proposal that auto-commits
    const committedRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Agent proposal for cancel tests",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Committed timeline.\n",
          },
        ],
      });

    expect(committedRes.body.status).toBe("committed");
    committedProposalId = committedRes.body.proposal_id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("successfully cancels a pending proposal", async () => {
    const res = await request(ctx.app)
      .post(`/api/proposals/${pendingProposalId}/cancel`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body.proposal_id).toBe(pendingProposalId);
    expect(res.body.status).toBe("withdrawn");
  });

  it("cancelled proposal appears as withdrawn in GET /api/proposals/:id", async () => {
    const res = await request(ctx.app)
      .get(`/api/proposals/${pendingProposalId}`);

    expect(res.status).toBe(200);
    expect(res.body.proposal.status).toBe("withdrawn");
  });

  it("accepts optional reason for cancellation", async () => {
    // Create a fresh pending proposal
    const createRes = await request(ctx.app)
      .post("/api/proposals?replace=true")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Another human edit to cancel",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Will be cancelled with reason.\n",
          },
        ],
      });

    expect(createRes.body.status).toBe("draft");

    const res = await request(ctx.app)
      .post(`/api/proposals/${createRes.body.proposal_id}/cancel`)
      .set("Authorization", ctx.humanToken)
      .send({ reason: "Changed my mind" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("withdrawn");
  });

  it("returns 409 on committed proposal", async () => {
    const res = await request(ctx.app)
      .post(`/api/proposals/${committedProposalId}/cancel`)
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(409);
  });

  it("returns 403 if not owner", async () => {
    const otherToken = authFor("other-user", "agent");

    // Need a fresh pending proposal for this test
    const createRes = await request(ctx.app)
      .post("/api/proposals?replace=true")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "For forbidden cancel test",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Cannot cancel this.\n",
          },
        ],
      });

    expect(createRes.body.status).toBe("draft");

    const res = await request(ctx.app)
      .post(`/api/proposals/${createRes.body.proposal_id}/cancel`)
      .set("Authorization", otherToken);

    expect(res.status).toBe(403);
  });

  it("returns 404 for non-existent proposal", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals/nonexistent-id-12345/cancel")
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(ctx.app)
      .post(`/api/proposals/${committedProposalId}/cancel`);

    expect(res.status).toBe(401);
  });
});
