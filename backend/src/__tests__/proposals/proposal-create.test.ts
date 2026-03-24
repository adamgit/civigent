import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

describe("POST /api/proposals — create proposal", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("creates proposal in pending status with outcome=accepted and no committed_head", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Update overview section",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Updated overview content.\n",
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.proposal_id).toBeDefined();
    expect(res.body.status).toBe("draft");
    expect(res.body.outcome).toBe("accepted");
    expect(res.body.committed_head).toBeUndefined();
    expect(res.body.evaluation).toBeDefined();
    expect(res.body.sections).toBeDefined();
  });

  it("returns 400 if intent missing", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Content.\n",
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 if sections missing", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Missing sections",
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 if sections is empty array", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Empty sections",
        sections: [],
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 if section missing doc_path", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Missing doc_path",
        sections: [
          {
            heading_path: ["Overview"],
            content: "Content.\n",
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 if section missing heading_path", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Missing heading_path",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            content: "Content.\n",
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 if section missing content", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Missing content",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
          },
        ],
      });

    expect(res.status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const res = await request(ctx.app)
      .post("/api/proposals")
      .send({
        intent: "No auth",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Content.\n",
          },
        ],
      });

    expect(res.status).toBe(401);
  });
});
