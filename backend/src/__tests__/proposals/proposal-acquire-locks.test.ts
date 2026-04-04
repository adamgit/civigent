import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import { createProposal, transitionToInProgress } from "../../storage/proposal-repository.js";

describe("POST /api/proposals/:id/acquire-locks — lock acquisition", () => {
  let ctx: TestServerContext;
  let draftProposalId: string;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Create a human draft proposal
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Human edit for lock tests",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Content for lock test.\n",
          },
        ],
      });

    expect(createRes.body.status).toBe("draft");
    draftProposalId = createRes.body.proposal_id;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("successfully acquires locks and transitions to inprogress", async () => {
    const res = await request(ctx.app)
      .post(`/api/proposals/${draftProposalId}/acquire-locks`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body.proposal_id).toBe(draftProposalId);
    expect(res.body.acquired).toBe(true);
    expect(res.body.status).toBe("inprogress");
  });

  it("returns 409 if proposal is already inprogress", async () => {
    const res = await request(ctx.app)
      .post(`/api/proposals/${draftProposalId}/acquire-locks`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(409);
  });

  it("returns 409 for agent proposals", async () => {
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Agent proposal for lock tests",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Agent content.\n",
          },
        ],
      });

    expect(createRes.body.status).toBe("draft");

    const res = await request(ctx.app)
      .post(`/api/proposals/${createRes.body.proposal_id}/acquire-locks`)
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(409);
  });

  it("returns 403 if not owner", async () => {
    const otherToken = authFor("other-user", "human");

    const res = await request(ctx.app)
      .post(`/api/proposals/${draftProposalId}/acquire-locks`)
      .set("Authorization", otherToken);

    expect(res.status).toBe(403);
  });

  it("returns 404 for non-existent proposal", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals/nonexistent-id-12345/acquire-locks")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(404);
  });

  it("returns failure when section is locked by another inprogress proposal", async () => {
    // draftProposalId is inprogress, locking ["Overview"]
    // Bypass API contention check by creating directly via repository
    const otherHumanWriter = { type: "human" as const, id: "other-human", displayName: "Other Human" };
    const { id: competingId } = await createProposal(otherHumanWriter, "Competing edit", [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
    ]);

    const otherHumanToken = authFor("other-human", "human");
    const res = await request(ctx.app)
      .post(`/api/proposals/${competingId}/acquire-locks`)
      .set("Authorization", otherHumanToken);

    expect(res.status).toBe(200);
    expect(res.body.acquired).toBe(false);
    expect(res.body.reason).toBeDefined();
    expect(res.body.section).toBeDefined();
    expect(res.body.section.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(res.body.section.heading_path).toEqual(["Overview"]);
  });
});
