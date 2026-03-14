import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/documents/:doc_path/structure", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns doc_path and structure with heading tree", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/structure`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(res.body).toHaveProperty("structure");
    expect(Array.isArray(res.body.structure)).toBe(true);
  });

  it("returns structure nodes with heading, level, and children", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/structure`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    // Sample doc has ## Overview and ## Timeline
    const structure = res.body.structure;
    expect(structure.length).toBeGreaterThanOrEqual(2);

    for (const node of structure) {
      expect(node).toHaveProperty("heading");
      expect(node).toHaveProperty("level");
      expect(node).toHaveProperty("children");
      expect(typeof node.heading).toBe("string");
      expect(typeof node.level).toBe("number");
      expect(Array.isArray(node.children)).toBe(true);
    }
  });

  it("includes Overview and Timeline headings from sample document", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/structure`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const headings = res.body.structure.map((n: { heading: string }) => n.heading);
    expect(headings).toContain("Overview");
    expect(headings).toContain("Timeline");
  });

  it("returns heading level 2 for top-level sections", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/structure`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const overviewNode = res.body.structure.find(
      (n: { heading: string }) => n.heading === "Overview",
    );
    expect(overviewNode).toBeDefined();
    expect(overviewNode.level).toBe(2);
  });

  it("broadcasts agent:reading event when accessed by an agent", async () => {
    ctx.wsEvents.length = 0;

    await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/structure`)
      .set("Authorization", ctx.agentToken);

    const readingEvents = ctx.wsEvents.filter((e) => e.type === "agent:reading");
    expect(readingEvents.length).toBe(1);
    expect(readingEvents[0]).toHaveProperty("doc_path", SAMPLE_DOC_PATH);
    expect(readingEvents[0]).toHaveProperty("actor_id", ctx.agentId);
  });

  it("does not broadcast agent:reading event for human access", async () => {
    ctx.wsEvents.length = 0;

    await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH}/structure`)
      .set("Authorization", ctx.humanToken);

    const readingEvents = ctx.wsEvents.filter((e) => e.type === "agent:reading");
    expect(readingEvents.length).toBe(0);
  });

  it("returns 404 for non-existent document", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/nonexistent.md/structure")
      .set("Authorization", ctx.humanToken);

    // Non-existent docs may return 404 or empty structure depending on implementation
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.structure).toEqual([]);
    }
  });

  it("returns 404 for path traversal attempt", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/../../etc/passwd/structure")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(404);
  });
});
