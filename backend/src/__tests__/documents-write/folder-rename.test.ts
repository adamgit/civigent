import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { createTestServer } from "../helpers/test-server.js";
import type { TestServerContext } from "../helpers/test-server.js";
import { gitExec } from "../../storage/git-repo.js";

const SOURCE_DOCS = ["/team/alpha.md", "/team/sub/beta.md", "/team/sub/deep/gamma.md"];
const EXPECTED_RENAMES = SOURCE_DOCS.map((doc) => ({
  old_path: doc,
  new_path: doc.replace(/^\/team/, "/squad"),
}));

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

describe("POST /api/workspace-folder/:folderPath/rename", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
    for (const doc of SOURCE_DOCS) {
      await createDoc(ctx, doc);
    }
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("renames every descendant document in one atomic commit, moving skeleton dirs", async () => {
    const commitsBefore = await commitCount(ctx);
    ctx.wsEvents.length = 0;

    const res = await request(ctx.app)
      .post("/api/workspace-folder/team/rename")
      .set("Authorization", ctx.humanToken)
      .send({ new_path: "/squad" });

    expect(res.status).toBe(200);
    expect(res.body.old_folder_path).toBe("/team");
    expect(res.body.new_folder_path).toBe("/squad");
    const sortByOld = (a: { old_path: string }, b: { old_path: string }) =>
      a.old_path.localeCompare(b.old_path);
    expect([...res.body.renamed].sort(sortByOld)).toEqual([...EXPECTED_RENAMES].sort(sortByOld));
    expect(typeof res.body.committed_head).toBe("string");

    for (const { old_path, new_path } of EXPECTED_RENAMES) {
      const oldRead = await request(ctx.app)
        .get(`/api/canonical${old_path}`)
        .set("Authorization", ctx.humanToken);
      expect(oldRead.status).toBe(404);

      const newRead = await request(ctx.app)
        .get(`/api/canonical${new_path}`)
        .set("Authorization", ctx.humanToken);
      expect(newRead.status).toBe(200);
      expect(newRead.body.content).toContain(`Body of ${old_path}.`);
    }

    const movedSectionsDir = join(ctx.dataCtx.contentDir, "squad/sub/beta.md.sections");
    expect((await stat(movedSectionsDir)).isDirectory()).toBe(true);
    await expect(access(join(ctx.dataCtx.contentDir, "team"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(await commitCount(ctx)).toBe(commitsBefore + 1);

    const catalogEvents = ctx.wsEvents.filter((e) => e.type === "catalog:changed");
    expect(catalogEvents).toHaveLength(1);
    expect([...(catalogEvents[0].added_doc_paths ?? [])].sort()).toEqual(
      EXPECTED_RENAMES.map((r) => r.new_path).sort(),
    );
    expect([...(catalogEvents[0].removed_doc_paths ?? [])].sort()).toEqual(
      EXPECTED_RENAMES.map((r) => r.old_path).sort(),
    );
    expect(ctx.wsEvents.filter((e) => e.type === "doc:renamed")).toHaveLength(0);
  });
});
