import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("PUT /api/documents/:doc_path (create)", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("creates a new document and returns 201 with doc_path", async () => {
    const res = await request(ctx.app)
      .put("/api/documents/new/test-doc.md")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "text/markdown")
      .send("# Test Document\n\nSome content here.\n");

    expect(res.status).toBe(201);
    expect(res.body.doc_path).toBe("new/test-doc.md");
  });

  it("returns 409 if document already exists", async () => {
    const res = await request(ctx.app)
      .put(`/api/documents/${SAMPLE_DOC_PATH}`)
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "text/markdown")
      .send("# Duplicate\n\nShould conflict.\n");

    expect(res.status).toBe(409);
  });

  it("returns error for invalid path with traversal", async () => {
    const res = await request(ctx.app)
      .put("/api/documents/../../bad.md")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "text/markdown")
      .send("# Bad path\n");

    // Express may normalize the path (returning 404) or the handler rejects it (400)
    expect([400, 404]).toContain(res.status);
  });
});
