/**
 * Group A9: REST API Section Reads Invariant Tests
 *
 * Iteration 3.5 invariant tests for GET /documents/:docPath/sections.
 * Document section reads are canonical-only; live CRDT/proposal state is not
 * overlaid through this endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH, SAMPLE_SECTIONS } from "../helpers/sample-content.js";

/** URL-safe doc path (no leading slash, to avoid double-slash in Express routes). */
const DOC_PATH_URL = SAMPLE_DOC_PATH.replace(/^\/+/, "");

describe("A9: REST API Section Reads Invariants", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("A9.1: GET sections returns canonical section content", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${DOC_PATH_URL}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections)).toBe(true);

    // Find Overview section
    const overview = res.body.sections.find(
      (s: any) => s.heading_path.length === 1 && s.heading_path[0] === "Overview",
    );
    expect(overview).toBeDefined();
    expect(overview.content).toContain(SAMPLE_SECTIONS.overview);
  });

  it("A9.2: section list reflects canonical DocumentSkeleton structure", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${DOC_PATH_URL}/sections`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const headings = res.body.sections.map((s: any) => s.heading_path);
    const hasOverview = headings.some((hp: string[]) => hp.length === 1 && hp[0] === "Overview");
    const hasTimeline = headings.some((hp: string[]) => hp.length === 1 && hp[0] === "Timeline");
    expect(hasOverview).toBe(true);
    expect(hasTimeline).toBe(true);
  });
});
