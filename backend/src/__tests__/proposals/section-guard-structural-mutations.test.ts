import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  createSampleDocument,
  createHumanCommit,
  SAMPLE_DOC_PATH,
} from "../helpers/sample-content.js";

describe("SectionGuard: structural mutations respect writer type", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("human creates a doc, edits it, then deletes it — succeeds (not 409)", async () => {
    // 1. Human creates a document
    const createRes = await request(ctx.app)
      .put("/api/documents/guard-test/human-lifecycle.md")
      .set("Authorization", ctx.humanToken)
      .set("Content-Type", "text/markdown")
      .send("# Lifecycle Test\n\nInitial content.\n");

    expect(createRes.status).toBe(201);
    expect(createRes.body.doc_path).toBe("/guard-test/human-lifecycle.md");

    // 2. Simulate a recent human edit (0.01 hours ago = 36 seconds)
    await createHumanCommit(
      ctx.dataCtx.rootDir,
      "/guard-test/human-lifecycle.md",
      "--before-first-heading--sample.md",
      "Edited by human.\n",
      0.01,
    );

    // 3. Human deletes the document — should succeed, not be blocked by SectionGuard
    const deleteRes = await request(ctx.app)
      .delete("/api/documents/guard-test/human-lifecycle.md")
      .set("Authorization", ctx.humanToken);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.deleted).toBe(true);
    expect(deleteRes.body.committed_head).toBeDefined();
  });

  it("agent attempts to delete a doc with recent human activity — blocked by SectionGuard", async () => {
    // 1. Create a document (via human, but that's fine — it's the git history that matters)
    await createSampleDocument(ctx.dataCtx.rootDir, "/guard-test/agent-blocked.md");

    // 2. Simulate a very recent human edit (0.01 hours ago)
    await createHumanCommit(
      ctx.dataCtx.rootDir,
      "/guard-test/agent-blocked.md",
      "overview.md",
      "Human-edited overview.\n",
      0.01,
    );

    // 3. Agent attempts to delete — should be blocked
    const deleteRes = await request(ctx.app)
      .delete("/api/documents/guard-test/agent-blocked.md")
      .set("Authorization", ctx.agentToken);

    expect(deleteRes.status).toBe(409);
    expect(deleteRes.body.outcome).toBe("blocked");
    expect(deleteRes.body.message).toBeDefined();
    expect(deleteRes.body.message).toMatch(/Proposal blocked/);
    expect(deleteRes.body.blocked_sections).toBeDefined();
    expect(deleteRes.body.blocked_sections.length).toBeGreaterThan(0);
  });
});
