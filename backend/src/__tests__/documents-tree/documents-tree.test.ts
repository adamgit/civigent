import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/documents/tree", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns { tree } with hierarchical listing", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/tree")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tree");
    expect(Array.isArray(res.body.tree)).toBe(true);
  });

  it("after creating a document, tree contains the new entry", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/tree")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).toContain("strategy");
  });

  it("entries have name, path, type properties", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/tree")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);

    const allEntries: unknown[] = [];
    const collect = (items: any[]) => {
      for (const e of items) {
        allEntries.push(e);
        if (e.children) collect(e.children);
      }
    };
    collect(res.body.tree);

    expect(allEntries.length).toBeGreaterThan(0);
    for (const entry of allEntries as Record<string, unknown>[]) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("path");
      expect(entry).toHaveProperty("type");
    }
  });
});
