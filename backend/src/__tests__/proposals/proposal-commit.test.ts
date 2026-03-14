import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

describe("POST /api/proposals/:id/commit — commit proposal", () => {
  let ctx: TestServerContext;
  let pendingProposalId: string;
  let committedProposalId: string;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Create a human_reservation proposal (stays pending — can be committed)
    const pendingRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Human edit for commit tests",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Human content to commit.\n",
          },
        ],
      });

    expect(pendingRes.body.status).toBe("pending");
    pendingProposalId = pendingRes.body.proposal_id;

    // Create an agent proposal that auto-commits
    const committedRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Agent proposal for commit tests",
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

  it("successfully commits a pending proposal and returns committed_head", async () => {
    const res = await request(ctx.app)
      .post(`/api/proposals/${pendingProposalId}/commit`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body.proposal_id).toBe(pendingProposalId);
    expect(res.body.status).toBe("committed");
    expect(res.body.outcome).toBe("accepted");
    expect(res.body.committed_head).toBeDefined();
    expect(typeof res.body.committed_head).toBe("string");
    expect(res.body.committed_head.length).toBeGreaterThan(0);
  });

  it("broadcasts content:committed WS event on successful commit", async () => {
    // Create another pending proposal to commit
    const createRes = await request(ctx.app)
      .post("/api/proposals?replace=true")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Human edit for WS event test",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Content for WS event test.\n",
          },
        ],
      });

    expect(createRes.body.status).toBe("pending");
    const proposalId = createRes.body.proposal_id;

    ctx.wsEvents.length = 0;

    await request(ctx.app)
      .post(`/api/proposals/${proposalId}/commit`)
      .set("Authorization", ctx.humanToken);

    const commitEvents = ctx.wsEvents.filter((e) => e.type === "content:committed");
    expect(commitEvents.length).toBe(1);
  });

  it("returns 409 if already committed", async () => {
    const res = await request(ctx.app)
      .post(`/api/proposals/${committedProposalId}/commit`)
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(409);
  });

  it("returns 403 if not owner", async () => {
    const otherToken = authFor("other-user", "agent");

    const res = await request(ctx.app)
      .post(`/api/proposals/${committedProposalId}/commit`)
      .set("Authorization", otherToken);

    expect(res.status).toBe(403);
  });

  it("returns 404 for non-existent proposal", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals/nonexistent-id-12345/commit")
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(ctx.app)
      .post(`/api/proposals/${committedProposalId}/commit`);

    expect(res.status).toBe(401);
  });
});
