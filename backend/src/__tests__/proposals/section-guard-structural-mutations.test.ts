import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createHumanCommit } from "../helpers/sample-content.js";

/**
 * Retargeted from the legacy SectionGuard structural-mutation suite.
 *
 * Area F owns the FSM-lock contention primitive only. The case "human creates,
 * edits, then deletes a document — succeeds" is FSM-lock-relevant: human
 * structural mutations are not gated by another writer's recency/scoring, only
 * by exclusive proposal locks (of which there are none here).
 *
 * The legacy second case — "agent blocked from deleting a doc with recent human
 * activity" — is agent-write-policy scoring (recency/aggregate-impact), NOT an
 * FSM lock. That assertion moves with Area G (agent-write-policy) and is
 * intentionally NOT reproduced here.
 */
describe("structural mutations: human lifecycle is not lock-gated", () => {
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

    // 3. Human deletes the document — not gated by FSM locks (no competing
    //    proposal holds these sections), so it succeeds.
    const deleteRes = await request(ctx.app)
      .delete("/api/documents/guard-test/human-lifecycle.md")
      .set("Authorization", ctx.humanToken);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.deleted).toBe(true);
    expect(deleteRes.body.committed_head).toBeDefined();
  });
});
