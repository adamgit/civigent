import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { readdir } from "node:fs/promises";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";
import { setDocAcl, invalidateCache } from "../../auth/acl.js";
import { RoleName } from "../../types/shared.js";
import { gitExec } from "../../storage/git-repo.js";

const OPEN_DOC = "/guarded/open.md";
const RESTRICTED_DOC = "/guarded/private/secret.md";

async function createDoc(ctx: TestServerContext, docPath: string): Promise<void> {
  const res = await request(ctx.app)
    .put(`/api/workspace${docPath}`)
    .set("Authorization", ctx.humanToken)
    .set("Content-Type", "application/json")
    .send({ markdown: `# Heading\n\nBody of ${docPath}.\n` });
  expect(res.status).toBe(201);
}

async function commitCount(ctx: TestServerContext): Promise<number> {
  return Number(await gitExec(["rev-list", "--count", "HEAD"], ctx.dataCtx.rootDir));
}

describe("folder delete all-or-nothing authorization", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    invalidateCache();
    await createDoc(ctx, OPEN_DOC);
    await createDoc(ctx, RESTRICTED_DOC);
    await setDocAcl("/guarded/private", { write: RoleName.of("restricted-team") });
  });

  afterAll(async () => {
    invalidateCache();
    await ctx.cleanup();
  });

  it("returns 403 for a denied descendant and leaves canonical and proposal store untouched", async () => {
    const commitsBefore = await commitCount(ctx);
    ctx.wsEvents.length = 0;

    const res = await request(ctx.app)
      .delete("/api/workspace-folder/guarded")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(403);
    expect(res.body.message).toContain(RESTRICTED_DOC);

    for (const doc of [OPEN_DOC, RESTRICTED_DOC]) {
      const read = await request(ctx.app)
        .get(`/api/canonical${doc}`)
        .set("Authorization", ctx.humanToken);
      expect(read.status).toBe(200);
    }

    expect(await commitCount(ctx)).toBe(commitsBefore);
    expect(await readdir(ctx.dataCtx.proposalsInflightDir)).toEqual([]);
    expect(ctx.wsEvents.filter((e) => e.type === "catalog:changed")).toHaveLength(0);
  });
});
