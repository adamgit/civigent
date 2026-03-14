import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument, createSampleDocument2, SAMPLE_DOC_PATH, SAMPLE_DOC_PATH_2 } from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/heatmap", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    await createSampleDocument2(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns { preset, sections } array", async () => {
    const res = await request(ctx.app)
      .get("/api/heatmap")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("preset");
    expect(res.body).toHaveProperty("sections");
    expect(Array.isArray(res.body.sections)).toBe(true);
  });

  it("returns humanInvolvement_midpoint_seconds and humanInvolvement_steepness", async () => {
    const res = await request(ctx.app)
      .get("/api/heatmap")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(typeof res.body.humanInvolvement_midpoint_seconds).toBe("number");
    expect(typeof res.body.humanInvolvement_steepness).toBe("number");
  });

  it("each entry has doc_path, heading_path, humanInvolvement_score, crdt_session_active", async () => {
    const res = await request(ctx.app)
      .get("/api/heatmap")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);

    for (const entry of res.body.sections) {
      expect(entry).toHaveProperty("doc_path");
      expect(entry).toHaveProperty("heading_path");
      expect(entry).toHaveProperty("humanInvolvement_score");
      expect(entry).toHaveProperty("crdt_session_active");
      expect(typeof entry.humanInvolvement_score).toBe("number");
      expect(typeof entry.crdt_session_active).toBe("boolean");
      expect(Array.isArray(entry.heading_path)).toBe(true);
    }
  });

  it("includes sections from both sample documents", async () => {
    const res = await request(ctx.app)
      .get("/api/heatmap")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const docPaths = new Set(res.body.sections.map((s: { doc_path: string }) => s.doc_path));
    expect(docPaths.has(SAMPLE_DOC_PATH)).toBe(true);
    expect(docPaths.has(SAMPLE_DOC_PATH_2)).toBe(true);
  });

  it("sections for sample doc include Overview and Timeline headings", async () => {
    const res = await request(ctx.app)
      .get("/api/heatmap")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const sampleSections = res.body.sections.filter(
      (s: { doc_path: string }) => s.doc_path === SAMPLE_DOC_PATH,
    );

    const headings = sampleSections.map(
      (s: { heading_path: string[] }) => s.heading_path.join(">>"),
    );
    expect(headings).toContain("Overview");
    expect(headings).toContain("Timeline");
  });

  it("humanInvolvement_score is between 0 and 1", async () => {
    const res = await request(ctx.app)
      .get("/api/heatmap")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    for (const entry of res.body.sections) {
      expect(entry.humanInvolvement_score).toBeGreaterThanOrEqual(0);
      expect(entry.humanInvolvement_score).toBeLessThanOrEqual(1);
    }
  });

  it("crdt_session_active is false when no active sessions", async () => {
    const res = await request(ctx.app)
      .get("/api/heatmap")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    for (const entry of res.body.sections) {
      expect(entry.crdt_session_active).toBe(false);
    }
  });
});
