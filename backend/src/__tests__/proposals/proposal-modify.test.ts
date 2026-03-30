import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

describe("PUT /api/proposals/:id — modify proposal", () => {
  let ctx: TestServerContext;
  let pendingProposalId: string;
  let committedProposalId: string;
  let prevAuthMode: string | undefined;

  beforeAll(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Create a human_reservation proposal (stays pending)
    const pendingRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Human edit for modify tests",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Initial human content.\n",
          },
        ],
      });

    expect(pendingRes.body.status).toBe("draft");
    pendingProposalId = pendingRes.body.proposal_id;

    // Create an agent proposal and commit it explicitly
    const committedRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Agent proposal for modify tests",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Committed timeline.\n",
          },
        ],
      });

    committedProposalId = committedRes.body.proposal_id;

    const commitRes = await request(ctx.app)
      .post(`/api/proposals/${committedProposalId}/commit`)
      .set("Authorization", ctx.agentToken);
    expect(commitRes.body.status).toBe("committed");
  });

  afterAll(async () => {
    await ctx.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("successfully modifies a pending proposal", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Updated human content.\n",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeDefined();
  });

  it("returns updated proposal with modified sections", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Further updated content.\n",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.proposal.sections).toBeDefined();
    expect(Array.isArray(res.body.proposal.sections)).toBe(true);
  });

  it("returns 409 if proposal is already committed", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${committedProposalId}`)
      .set("Authorization", ctx.agentToken)
      .send({
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Cannot modify committed.\n",
          },
        ],
      });

    expect(res.status).toBe(409);
  });

  it("returns 403 if not proposal owner", async () => {
    const otherToken = authFor("other-user", "agent");

    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .set("Authorization", otherToken)
      .send({
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Unauthorized modification.\n",
          },
        ],
      });

    expect(res.status).toBe(403);
  });

  it("returns 404 for non-existent proposal", async () => {
    const res = await request(ctx.app)
      .put("/api/proposals/nonexistent-id-12345")
      .set("Authorization", ctx.agentToken)
      .send({
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Update nonexistent.\n",
          },
        ],
      });

    expect(res.status).toBe(404);
  });

  it("returns 400 if sections is empty", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({
        sections: [],
      });

    expect(res.status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .send({
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "No auth.\n",
          },
        ],
      });

    expect(res.status).toBe(401);
  });
});
