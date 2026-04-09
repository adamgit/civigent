import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import { listProposals } from "../../storage/proposal-repository.js";

describe("Proposal single-pending invariant", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("allows multiple pending proposals from same human writer", async () => {
    // Humans are exempt from the single-draft limit per spec invariant 11.
    const writerToken = authFor("invariant-writer-1", "human");

    const first = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writerToken)
      .send({

        intent: "First reservation",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "First.\n",
          },
        ],
      });

    expect(first.status).toBe(201);
    expect(first.body.status).toBe("draft");

    const second = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writerToken)
      .send({

        intent: "Second reservation",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Second.\n",
          },
        ],
      });

    expect(second.status).toBe(201);
    expect(second.body.status).toBe("draft");
    expect(second.body.proposal_id).toBeDefined();
    expect(second.body.proposal_id).not.toBe(first.body.proposal_id);
  });

  it("replace=true withdraws old pending and creates new one", async () => {
    const writerToken = authFor("invariant-writer-2", "human");

    const first = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writerToken)
      .send({

        intent: "First proposal",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Stakeholders"],
            content: "First update.\n",
          },
        ],
      });

    expect(first.status).toBe(201);
    expect(first.body.status).toBe("draft");

    const second = await request(ctx.app)
      .post("/api/proposals?replace=true")
      .set("Authorization", writerToken)
      .send({

        intent: "Second proposal with replace",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Stakeholders"],
            content: "Second update.\n",
          },
        ],
      });

    expect(second.status).toBe(201);
    expect(second.body.proposal_id).toBeDefined();
    expect(second.body.proposal_id).not.toBe(first.body.proposal_id);

    // Verify old proposal was withdrawn
    const oldRes = await request(ctx.app).get(`/api/proposals/${first.body.proposal_id}`);
    expect(oldRes.body.proposal.status).toBe("withdrawn");
  });

  it("tier-3 agent can create multiple drafts via REST without conflict", async () => {
    // Tier-3 agents (and humans) are exempt from the single-draft limit per spec invariant 11.
    const writerToken = authFor("multi-draft-agent", "agent");

    const first = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writerToken)
      .send({
        intent: "Tier-3 agent first draft",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Agent first.\n",
          },
        ],
      });

    expect(first.status).toBe(201);
    expect(first.body.proposal_id).toBeDefined();

    const second = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writerToken)
      .send({
        intent: "Tier-3 agent second draft",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Agent second.\n",
          },
        ],
      });

    expect(second.status).toBe(201);
    expect(second.body.proposal_id).toBeDefined();
    expect(second.body.proposal_id).not.toBe(first.body.proposal_id);

    // Both drafts should appear in the draft listing for this writer
    const drafts = await listProposals("draft");
    const writerDrafts = drafts.filter((p) => p.writer.id === "multi-draft-agent");
    const writerDraftIds = writerDrafts.map((p) => p.id).sort();
    expect(writerDraftIds).toEqual([first.body.proposal_id, second.body.proposal_id].sort());
  });

  it("two proposals from different writers both succeed", async () => {
    const writer1Token = authFor("writer-1-unique", "agent");
    const writer2Token = authFor("writer-2-unique", "agent");

    const first = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writer1Token)
      .send({
        intent: "Writer 1 proposal",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Writer 1 timeline update.\n",
          },
        ],
      });

    expect(first.status).toBe(201);

    const second = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writer2Token)
      .send({
        intent: "Writer 2 proposal",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Timeline"],
            content: "Writer 2 timeline update.\n",
          },
        ],
      });

    expect(second.status).toBe(201);
  });

  it("committed proposals do not block new proposals from same writer", async () => {
    const writerToken = authFor("invariant-writer-3", "agent");

    // First proposal starts pending (2-phase: all proposals start pending)
    const first = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writerToken)
      .send({
        intent: "First agent proposal",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Budget"],
            content: "Agent first.\n",
          },
        ],
      });

    expect(first.status).toBe(201);
    expect(first.body.status).toBe("draft");

    // Commit the first proposal via commit_proposal
    const commitRes = await request(ctx.app)
      .post(`/api/proposals/${first.body.proposal_id}/commit`)
      .set("Authorization", writerToken);

    expect(commitRes.status).toBe(200);

    // Second proposal should succeed since first is already committed
    const second = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", writerToken)
      .send({
        intent: "Second agent proposal",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Risks"],
            content: "Agent second.\n",
          },
        ],
      });

    expect(second.status).toBe(201);
  });
});
