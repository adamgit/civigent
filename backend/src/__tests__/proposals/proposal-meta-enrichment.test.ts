import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";

describe("Proposal meta.json enrichment after FSM transitions", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("committed meta.json contains committed_head and humanInvolvement_at_commit", async () => {
    // Create a pending proposal
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.agentToken)
      .send({
        intent: "Agent proposal for meta enrichment test",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Meta enrichment test content.\n",
          },
        ],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe("draft");
    const proposalId = createRes.body.proposal_id;

    // Commit the proposal
    const commitRes = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/commit`)
      .set("Authorization", ctx.agentToken);

    expect(commitRes.status).toBe(200);
    expect(commitRes.body.status).toBe("committed");

    // Read the meta.json directly from disk to verify enrichment
    const metaPath = join(
      ctx.dataCtx.rootDir,
      "proposals",
      "committed",
      proposalId,
      "meta.json",
    );
    const metaRaw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(metaRaw);

    expect(meta.committed_head).toBeDefined();
    expect(typeof meta.committed_head).toBe("string");
    expect(meta.committed_head.length).toBeGreaterThan(0);

    expect(meta.humanInvolvement_at_commit).toBeDefined();
  });

  it("withdrawn meta.json contains withdrawal_reason", async () => {
    const writerToken = authFor("meta-withdrawal-writer", "human");

    // Create a pending proposal
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writerToken)
      .send({
        intent: "Proposal to withdraw for meta test",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Content that will be withdrawn.\n",
          },
        ],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe("draft");
    const proposalId = createRes.body.proposal_id;

    // Withdraw the proposal (endpoint is /cancel)
    const withdrawRes = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/cancel`)
      .set("Authorization", writerToken)
      .send({ reason: "Changed my mind" });

    expect(withdrawRes.status).toBe(200);

    // Read the meta.json directly from disk to verify enrichment
    const metaPath = join(
      ctx.dataCtx.rootDir,
      "proposals",
      "withdrawn",
      proposalId,
      "meta.json",
    );
    const metaRaw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(metaRaw);

    expect(meta.withdrawal_reason).toBe("Changed my mind");
  });
});
