import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

describe("GET /api/proposals/:id — read proposal", () => {
  let ctx: TestServerContext;
  let committedProposalId: string;
  let pendingProposalId: string;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Create an agent proposal that auto-commits
    const committedRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Agent proposal for read test",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Read test committed content.\n",
          },
        ],
      });

    committedProposalId = committedRes.body.proposal_id;

    // Create a human_reservation proposal (stays pending)
    const pendingRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Human edit for read test",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Read test pending content.\n",
          },
        ],
      });

    pendingProposalId = pendingRes.body.proposal_id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns committed proposal details", async () => {
    const res = await request(ctx.app).get(`/api/proposals/${committedProposalId}`);

    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeDefined();
    expect(res.body.proposal.id).toBe(committedProposalId);
    expect(res.body.proposal.status).toBe("committed");
  });

  it("returns pending proposal details", async () => {
    const res = await request(ctx.app).get(`/api/proposals/${pendingProposalId}`);

    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeDefined();
    expect(res.body.proposal.id).toBe(pendingProposalId);
    expect(res.body.proposal.status).toBe("draft");
  });

  it("returns proposal with writer, intent, and sections", async () => {
    const res = await request(ctx.app).get(`/api/proposals/${committedProposalId}`);

    expect(res.status).toBe(200);
    const proposal = res.body.proposal;
    expect(proposal.writer).toBeDefined();
    expect(proposal.writer.id).toBe(ctx.agentId);
    expect(proposal.intent).toBe("Agent proposal for read test");
    expect(Array.isArray(proposal.sections)).toBe(true);
    expect(proposal.sections.length).toBeGreaterThan(0);
  });

  it("proposal sections contain doc_path and heading_path", async () => {
    const res = await request(ctx.app).get(`/api/proposals/${committedProposalId}`);

    expect(res.status).toBe(200);
    const section = res.body.proposal.sections[0];
    expect(section.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(section.heading_path).toEqual(["Overview"]);
    expect(typeof section.content).toBe("string");
  });

  it("returns 404 for non-existent proposal", async () => {
    const res = await request(ctx.app).get("/api/proposals/nonexistent-id-12345");

    expect(res.status).toBe(404);
  });

  it("does not require authentication", async () => {
    const res = await request(ctx.app).get(`/api/proposals/${committedProposalId}`);

    // No Authorization header — should still work
    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeDefined();
  });
});
