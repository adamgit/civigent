import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";
import { gitExec } from "../../storage/git-repo.js";

const FOLDER_DOCS = ["/team/alpha.md", "/team/sub/beta.md", "/team/sub/deep/gamma.md"];
const OUTSIDE_DOC = "/other/keep.md";

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

describe("DELETE /api/workspace-folder/:folderPath", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    for (const doc of [...FOLDER_DOCS, OUTSIDE_DOC]) {
      await createDoc(ctx, doc);
    }
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("deletes every descendant document in one atomic commit and prunes the folder", async () => {
    const commitsBefore = await commitCount(ctx);
    ctx.wsEvents.length = 0;

    const res = await request(ctx.app)
      .delete("/api/workspace-folder/team")
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body.folder_path).toBe("/team");
    expect([...res.body.deleted_doc_paths].sort()).toEqual([...FOLDER_DOCS].sort());
    expect(typeof res.body.committed_head).toBe("string");
    expect(res.body.committed_head.length).toBeGreaterThan(0);

    for (const doc of FOLDER_DOCS) {
      const read = await request(ctx.app)
        .get(`/api/canonical${doc}`)
        .set("Authorization", ctx.humanToken);
      expect(read.status).toBe(404);
    }

    const outside = await request(ctx.app)
      .get(`/api/canonical${OUTSIDE_DOC}`)
      .set("Authorization", ctx.humanToken);
    expect(outside.status).toBe(200);

    expect(await commitCount(ctx)).toBe(commitsBefore + 1);

    await expect(access(join(ctx.dataCtx.contentDir, "team"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const catalogEvents = ctx.wsEvents.filter((e) => e.type === "catalog:changed");
    expect(catalogEvents).toHaveLength(1);
    expect([...(catalogEvents[0].removed_doc_paths ?? [])].sort()).toEqual([...FOLDER_DOCS].sort());
    expect(catalogEvents[0].added_doc_paths ?? []).toEqual([]);
    expect(ctx.wsEvents.filter((e) => e.type === "doc:renamed")).toHaveLength(0);
  });
});
