import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

describe("Proposals with zero sections — document-level operations", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  // A zero-section agent proposal carries zero targets (the create API cannot
  // attach a document target), so it claims and changes nothing: a known-
  // uncommittable draft. It is rejected at the REQUEST boundary (400) rather than
  // created and later failed at commit. Zero-section operations are valid ONLY
  // when they carry an explicit document target — see the PUT-create and
  // DELETE-tombstone cases below, which auto-commit proposals with document
  // targets and succeed.
  it("agent proposal with zero sections is rejected at the create boundary (400)", async () => {
    const agentToken = authFor("zero-sec-agent-1", "agent");

    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", agentToken)
      .send({
        intent: "Operation that claims nothing",
        sections: [],
      });

    // The uncommittable draft is never created: fail fast at the request boundary.
    expect(res.status).toBe(400);
    expect(res.body.proposal_id).toBeUndefined();
  });

  it("PUT /documents creates live-empty doc with zero sections via auto-committed proposal", async () => {
    const res = await request(ctx.app)
      .put("/api/workspace/test/zero-sections-create.md")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(201);
    expect(res.body.doc_path).toBe("/test/zero-sections-create.md");

    // Verify the document is live with zero sections
    const docRes = await request(ctx.app)
      .get("/api/workspace/test/zero-sections-create.md/sections")
      .set("Authorization", ctx.humanToken);

    expect(docRes.status).toBe(200);
    expect(docRes.body.sections).toHaveLength(0);
  });

  it("agent proposal with one section on empty doc creates only that section", async () => {
    // Create the empty document first
    const createRes = await request(ctx.app)
      .put("/api/workspace/test/with-overview.md")
      .set("Authorization", ctx.humanToken);

    expect(createRes.status).toBe(201);

    // Write a section via agent proposal (use unique agent to avoid pending-proposal conflict)
    const agentToken = authFor("overview-agent", "agent");
    const propRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", agentToken)
      .send({
        intent: "Add Overview section",
        sections: [
          {
            doc_path: "/test/with-overview.md",
            heading_path: ["Overview"],
            content: "Overview content.\n",
          },
        ],
      });

    expect(propRes.status).toBe(201);
    const proposalId = propRes.body.proposal_id;

    // Commit the proposal
    const commitRes = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/commit`)
      .set("Authorization", agentToken);

    expect(commitRes.status).toBe(200);
    expect(commitRes.body.outcome).toBe("accepted");

    // Verify the document has exactly one section (Overview), no synthetic BFH
    const docRes = await request(ctx.app)
      .get("/api/workspace/test/with-overview.md/sections")
      .set("Authorization", ctx.humanToken);

    expect(docRes.status).toBe(200);
    expect(docRes.body.sections).toHaveLength(1);
    expect(docRes.body.sections[0].heading).toBe("Overview");
  });

  it("DELETE removes a document via tombstone proposal", async () => {
    // Create a document first
    const createRes = await request(ctx.app)
      .put("/api/workspace/test/to-delete.md")
      .set("Authorization", ctx.humanToken);

    expect(createRes.status).toBe(201);

    // Delete it
    const deleteRes = await request(ctx.app)
      .delete("/api/workspace/test/to-delete.md")
      .set("Authorization", ctx.humanToken);

    expect(deleteRes.status).toBe(200);

    // Verify it's gone
    const readRes = await request(ctx.app)
      .get("/api/canonical/test/to-delete.md")
      .set("Authorization", ctx.humanToken);

    expect(readRes.status).toBe(404);
  });
});
