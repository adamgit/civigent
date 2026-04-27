import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { authFor } from "../helpers/auth.js";
import {
  createSampleDocument,
  SAMPLE_DOC_PATH,
  SAMPLE_SECTIONS,
} from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/documents/:doc_path/sections", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  function sectionByHeadingPath(
    sections: Array<{ heading_path: string[]; content: string }>,
    headingPath: string[],
  ): { heading_path: string[]; content: string } | undefined {
    return sections.find((section) => {
      if (section.heading_path.length !== headingPath.length) return false;
      return section.heading_path.every((segment, index) => segment === headingPath[index]);
    });
  }

  it("returns sections array", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(res.body.sections.length).toBeGreaterThan(0);
  });

  it("keeps existing behavior unchanged without proposal_id", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const overview = sectionByHeadingPath(res.body.sections, ["Overview"]);
    expect(overview?.content).toContain(SAMPLE_SECTIONS.overview);
  });

  it("returns proposal-overlay content when proposal_id is provided", async () => {
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Manual publish draft",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Proposal-specific overview content.",
          },
        ],
      });
    expect(createRes.status).toBe(201);
    const proposalId = createRes.body.proposal_id as string;

    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .query({ proposal_id: proposalId })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const overview = sectionByHeadingPath(res.body.sections, ["Overview"]);
    expect(overview?.content).toContain("Proposal-specific overview content.");
  });

  it("falls back to canonical content for untouched sections with proposal_id", async () => {
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({
        intent: "Manual publish draft fallback check",
        sections: [
          {
            doc_path: SAMPLE_DOC_PATH,
            heading_path: ["Overview"],
            content: "Overlay only for overview.",
          },
        ],
      });
    expect(createRes.status).toBe(201);
    const proposalId = createRes.body.proposal_id as string;

    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .query({ proposal_id: proposalId })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const timeline = sectionByHeadingPath(res.body.sections, ["Timeline"]);
    expect(timeline?.content).toContain(SAMPLE_SECTIONS.timeline);
  });

  it("returns 404 for invalid proposal_id", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .query({ proposal_id: "not-a-real-proposal-id" })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(404);
  });

  it("returns 403 for unrelated proposal_id owned by another writer", async () => {
    const otherHumanToken = authFor("human-other-user", "human");
    const createRes = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", otherHumanToken)
      .send({
        intent: "Other user's draft",
        sections: [],
      });
    expect(createRes.status).toBe(201);
    const proposalId = createRes.body.proposal_id as string;

    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .query({ proposal_id: proposalId })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(403);
  });

  it("each section has heading_path, content, humanInvolvement_score, word_count", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    for (const section of res.body.sections) {
      expect(section).toHaveProperty("heading_path");
      expect(section).toHaveProperty("content");
      expect(section).toHaveProperty("humanInvolvement_score");
      expect(section).toHaveProperty("word_count");
    }
  });

  it("returns 404 for non-existent document", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/nonexistent.md/sections")
      .set("Authorization", ctx.humanToken);

    // Non-existent docs return 404 (no skeleton on disk)
    expect(res.status).toBe(404);
  });
});
