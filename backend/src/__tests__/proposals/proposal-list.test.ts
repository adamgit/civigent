import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

describe("GET /api/proposals and GET /api/my-proposals — list proposals", () => {
  let ctx: TestServerContext;
  let secondWriterToken: string;
  let prevAuthMode: string | undefined;

  beforeAll(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    secondWriterToken = authFor("second-writer", "agent");

    // Create a proposal from the primary agent and commit it
    const first = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Agent proposal for list test",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Agent overview update.\n",
          },
        ],
      });
    await request(ctx.app)
      .post(`/api/proposals/${first.body.proposal_id}/commit`)
      .set("Authorization", ctx.agentToken);

    // Create a proposal from a second writer and commit it
    const second = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", secondWriterToken)
      .send({
        intent: "Second writer proposal for list test",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Second writer timeline update.\n",
          },
        ],
      });
    await request(ctx.app)
      .post(`/api/proposals/${second.body.proposal_id}/commit`)
      .set("Authorization", secondWriterToken);
  });

  afterAll(async () => {
    await ctx.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("GET /api/proposals returns all proposals", async () => {
    const res = await request(ctx.app).get("/api/proposals")
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(200);
    expect(res.body.proposals).toBeDefined();
    expect(Array.isArray(res.body.proposals)).toBe(true);
    expect(res.body.proposals.length).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/proposals?status=committed returns only committed proposals", async () => {
    const res = await request(ctx.app).get("/api/proposals?status=committed")
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(200);
    expect(res.body.proposals).toBeDefined();
    expect(Array.isArray(res.body.proposals)).toBe(true);
    for (const p of res.body.proposals) {
      expect(p.status).toBe("committed");
    }
  });

  it("GET /api/proposals?status=invalid returns 400", async () => {
    const res = await request(ctx.app).get("/api/proposals?status=invalid")
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(400);
  });

  it("GET /api/my-proposals returns 401 without auth", async () => {
    const res = await request(ctx.app).get("/api/my-proposals");

    expect(res.status).toBe(401);
  });

  it("GET /api/my-proposals with auth returns only the caller's proposals", async () => {
    const res = await request(ctx.app)
      .get("/api/my-proposals")
      .set("Authorization", ctx.agentToken);

    expect(res.status).toBe(200);
    expect(res.body.proposals).toBeDefined();
    expect(Array.isArray(res.body.proposals)).toBe(true);
    expect(res.body.proposals.length).toBeGreaterThanOrEqual(1);

    for (const p of res.body.proposals) {
      expect(p.writer.id).toBe(ctx.agentId);
    }
  });
});
