import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("PUT /api/workspace/:doc_path (create)", () => {
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
      .put("/api/workspace/new/test-doc.md")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "text/markdown")
      .send("# Test Document\n\nSome content here.\n");

    expect(res.status).toBe(201);
    expect(res.body.doc_path).toBe("/new/test-doc.md");
  });

  it("creates a document with initial markdown as one atomic commit", async () => {
    const markdown = "# Seeded Document\n\nInitial content from create.\n";
    const res = await request(ctx.app)
      .put("/api/workspace/new/seeded-doc.md")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "application/json")
      .send({ markdown });

    expect(res.status).toBe(201);
    expect(res.body.doc_path).toBe("/new/seeded-doc.md");

    const read = await request(ctx.app)
      .get("/api/canonical/new/seeded-doc.md")
      .set("Authorization", ctx.humanToken);
    expect(read.status).toBe(200);
    expect(read.body.content).toContain("Initial content from create.");

    const history = await request(ctx.app)
      .get("/api/canonical/new/seeded-doc.md/history")
      .set("Authorization", ctx.humanToken);
    expect(history.status).toBe(200);
    expect(history.body.versions).toHaveLength(1);
  });

  it("returns 409 if document already exists", async () => {
    const res = await request(ctx.app)
      .put(`/api/workspace/${SAMPLE_DOC_PATH.replace(/^\//, "")}`)
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "text/markdown")
      .send("# Duplicate\n\nShould conflict.\n");

    expect(res.status).toBe(409);
  });

  it("returns error for invalid path with traversal", async () => {
    const res = await request(ctx.app)
      .put("/api/workspace/../../bad.md")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "text/markdown")
      .send("# Bad path\n");

    // Express may normalize the path (returning 404) or the handler rejects it (400)
    expect([400, 404]).toContain(res.status);
  });
});
