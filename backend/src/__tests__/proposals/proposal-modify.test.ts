import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

// PUT /api/proposals/:id now updates ONLY the manifest (intent + target scope).
// Staged section CONTENT is written through the dedicated routes:
//   PUT /api/proposals/:id/sections                       (bulk)
//   PUT /api/proposals/:id/documents/:docPath/sections    (per-document)
describe("PUT /api/proposals/:id — manifest + staged-content split", () => {
  let ctx: TestServerContext;
  let pendingProposalId: string;
  let inProgressProposalId: string;
  let committedProposalId: string;
  let prevAuthMode: string | undefined;

  beforeAll(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Create a human_reservation proposal (stays draft)
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

    // Create a human proposal and transition to inprogress (locks acquired)
    const inProgressRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Human inprogress proposal for modify tests",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Inprogress initial content.\n",
          },
        ],
      });
    expect(inProgressRes.body.status).toBe("draft");
    inProgressProposalId = inProgressRes.body.proposal_id;

    const acquireLocksRes = await request(ctx.app)
      .post(`/api/proposals/${inProgressProposalId}/acquire-locks`)
      .set("Authorization", ctx.humanToken)
      .send({});
    expect(acquireLocksRes.status).toBe(200);
    expect(acquireLocksRes.body.acquired).toBe(true);

    // Create an agent proposal and commit it explicitly
    const committedRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Agent proposal for modify tests",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: [],
            content: "Committed preamble.\n",
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

  // ── Manifest route (intent + scope only, NO content) ──────────────────

  it("successfully updates a draft proposal manifest", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Updated intent",
        targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
      });

    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeDefined();
    expect(Array.isArray(res.body.proposal.sections)).toBe(true);
  });

  it("rejects a manifest body that carries section content fields (no content here)", async () => {
    // The narrowed route requires `targets[]`; a body shaped like the old
    // section-content payload (only `sections`) fails the parser.
    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({
        sections: [
          { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "x\n" },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("returns 409 when changing the selected scope after the proposal is inprogress", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${inProgressProposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({
        targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
      });

    expect(res.status).toBe(409);
  });

  it("returns 409 if the proposal is already committed", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${committedProposalId}`)
      .set("Authorization", ctx.agentToken)
      .send({
        targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: [] }],
      });

    expect(res.status).toBe(409);
  });

  it("returns 403 if not the proposal owner", async () => {
    const otherToken = authFor("other-user", "agent");

    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .set("Authorization", otherToken)
      .send({
        targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
      });

    expect(res.status).toBe(403);
  });

  it("returns 404 for a non-existent proposal", async () => {
    const res = await request(ctx.app)
      .put("/api/proposals/nonexistent-id-12345")
      .set("Authorization", ctx.agentToken)
      .send({
        targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
      });

    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .send({
        targets: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] }],
      });

    expect(res.status).toBe(401);
  });

  // ── Bulk staged-content route (PUT /api/proposals/:id/sections) ───────

  it("writes staged content in bulk and reflects it on the proposal read", async () => {
    const writeRes = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}/sections`)
      .set("Authorization", ctx.humanToken)
      .send({
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Bulk-written overview content.\n",
          },
        ],
      });
    expect(writeRes.status).toBe(200);
    expect(writeRes.body.proposal).toBeDefined();

    const readRes = await request(ctx.app)
      .get(`/api/proposals/${pendingProposalId}/documents${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);
    expect(readRes.status).toBe(200);
    const overview = readRes.body.sections.find(
      (s: { heading_path: string[] }) =>
        s.heading_path.length === 1 && s.heading_path[0] === "Overview",
    );
    expect(overview?.content).toContain("Bulk-written overview content.");
  });

  it("bulk staged-content write returns 403 for a non-owner", async () => {
    const otherToken = authFor("other-user", "agent");
    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}/sections`)
      .set("Authorization", otherToken)
      .send({
        sections: [
          { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "nope\n" },
        ],
      });
    expect(res.status).toBe(403);
  });

  it("bulk staged-content write returns 409 for a committed proposal", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/${committedProposalId}/sections`)
      .set("Authorization", ctx.agentToken)
      .send({
        sections: [
          { doc_path: SAMPLE_DOC_PATH, heading_path: [], content: "nope\n" },
        ],
      });
    expect(res.status).toBe(409);
  });

  // ── Per-document staged-content route ─────────────────────────────────

  it("writes staged content for a single document via the per-document route", async () => {
    const writeRes = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}/documents${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken)
      .send({
        sections: [
          { heading_path: ["Overview"], content: "Per-document overview content.\n" },
        ],
      });
    expect(writeRes.status).toBe(200);
    expect(writeRes.body.proposal).toBeDefined();

    const readRes = await request(ctx.app)
      .get(`/api/proposals/${pendingProposalId}/documents${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);
    expect(readRes.status).toBe(200);
    const overview = readRes.body.sections.find(
      (s: { heading_path: string[] }) =>
        s.heading_path.length === 1 && s.heading_path[0] === "Overview",
    );
    expect(overview?.content).toContain("Per-document overview content.");
  });

  it("per-document staged-content write returns 404 for a non-existent proposal", async () => {
    const res = await request(ctx.app)
      .put(`/api/proposals/nonexistent-id-12345/documents${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken)
      .send({
        sections: [{ heading_path: ["Overview"], content: "nope\n" }],
      });
    expect(res.status).toBe(404);
  });

  // ── Manifest empty-scope while draft is valid draft state ─────────────

  it("accepts an empty targets array on a draft (emptying a manual draft is valid draft state)", async () => {
    // Removing the last selected section of a manual draft persists an empty
    // draft scope. Empty draft state is valid and editable; the refusal for an
    // empty claim set lives at the lifecycle boundaries (acquire-locks / commit).
    const res = await request(ctx.app)
      .put(`/api/proposals/${pendingProposalId}`)
      .set("Authorization", ctx.humanToken)
      .send({ targets: [] });

    expect(res.status).toBe(200);
    expect(res.body.proposal.targets).toEqual([]);
    expect(res.body.proposal.sections).toEqual([]);
    // An empty draft is not corruption — it must carry no degraded marker.
    expect(res.body.proposal.degraded ?? []).toEqual([]);

    // The empty draft cannot acquire locks: the refusal is at the lifecycle
    // boundary, not at draft-editing persistence.
    const lockRes = await request(ctx.app)
      .post(`/api/proposals/${pendingProposalId}/acquire-locks`)
      .set("Authorization", ctx.humanToken)
      .send({});
    expect(lockRes.status).toBe(409);
  });
});
