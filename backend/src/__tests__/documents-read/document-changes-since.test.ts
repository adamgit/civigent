import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestServer } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { gitExec } from "../../storage/git-repo.js";
import type { TestServerContext } from "../helpers/test-server.js";

describe("GET /api/documents/:doc_path/changes-since", () => {
  let ctx: TestServerContext;
  let headSha: string;

  beforeAll(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    // Fetch the current head_sha
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}`)
      .set("Authorization", ctx.humanToken);
    headSha = res.body.head_sha;
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("returns response with since_sha, current_sha, changed, and changed_sections", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}/changes-since`)
      .query({ after_head: headSha })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("since_sha");
    expect(res.body).toHaveProperty("current_sha");
    expect(res.body).toHaveProperty("changed");
    expect(res.body).toHaveProperty("changed_sections");
    expect(typeof res.body.changed).toBe("boolean");
    expect(Array.isArray(res.body.changed_sections)).toBe(true);
  });

  it("returns no changes when SHA matches current HEAD", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}/changes-since`)
      .query({ after_head: headSha })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.changed_sections).toHaveLength(0);
    expect(res.body.since_sha).toBe(headSha);
    expect(res.body.current_sha).toBe(headSha);
  });

  it("returns changed=false when no after_head is provided", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}/changes-since`)
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.since_sha).toBe("");
    expect(res.body.changed_sections).toHaveLength(0);
  });

  it("returns current_sha as a non-empty string", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}/changes-since`)
      .query({ after_head: headSha })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(typeof res.body.current_sha).toBe("string");
    expect(res.body.current_sha.length).toBeGreaterThan(0);
  });

  it("detects changes when a committed proposal exists after the given SHA", async () => {
    const oldSha = headSha;

    // Create a committed proposal file that references a new commit
    const committedDir = join(ctx.dataCtx.rootDir, "proposals", "committed");
    await mkdir(committedDir, { recursive: true });

    // Make a new git commit to get a new SHA
    const sectionPath = join(ctx.dataCtx.rootDir, "content", SAMPLE_DOC_PATH.replace(/^\//, "") + ".sections", "overview.md");
    await writeFile(sectionPath, "Updated overview content.\n", "utf8");
    await gitExec(["add", "."], ctx.dataCtx.rootDir);
    await gitExec(
      ["-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "update overview"],
      ctx.dataCtx.rootDir,
    );

    // Get the new HEAD SHA
    const newHeadRes = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}`)
      .set("Authorization", ctx.humanToken);
    const newSha = newHeadRes.body.head_sha;

    // Write a committed proposal referencing the new SHA and our doc's section
    const proposalFile = {
      id: "test-proposal-1",
      writer: { id: "agent-1", type: "agent", displayName: "Test Agent" },
      intent: "update overview",
      sections: [
        {
          doc_path: SAMPLE_DOC_PATH,
          heading_path: ["Overview"],
          content: "Updated overview content.\n",
        },
      ],
      created_at: new Date().toISOString(),
      committed_head: newSha,
    };
    const proposalSubDir = join(committedDir, "test-proposal-1");
    await mkdir(proposalSubDir, { recursive: true });
    await writeFile(
      join(proposalSubDir, "meta.json"),
      JSON.stringify(proposalFile),
      "utf8",
    );

    // Now query changes since the old SHA
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}/changes-since`)
      .query({ after_head: oldSha })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.changed_sections.length).toBeGreaterThan(0);
    expect(res.body.changed_sections[0].doc_path).toBe(SAMPLE_DOC_PATH);
    expect(res.body.changed_sections[0].heading_path).toEqual(["Overview"]);
    expect(res.body.since_sha).toBe(oldSha);
    expect(res.body.current_sha).toBe(newSha);
  });

  it("returns changed=false for an invalid/unknown SHA (graceful degradation)", async () => {
    const res = await request(ctx.app)
      .get(`/api/documents/${SAMPLE_DOC_PATH.replace(/^\//, "")}/changes-since`)
      .query({ after_head: "0000000000000000000000000000000000000000" })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(200);
    // Invalid SHA should degrade gracefully — getCommitsBetween fails, returns no changes
    expect(res.body.changed).toBe(false);
    expect(res.body.changed_sections).toHaveLength(0);
  });

  it("returns 404 for path traversal attempt (URL-normalized before routing)", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/../../etc/passwd/changes-since")
      .query({ after_head: headSha })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(404);
  });

  it("returns 400 for non-.md path (InvalidDocPathError)", async () => {
    const res = await request(ctx.app)
      .get("/api/documents/secret-no-ext/changes-since")
      .query({ after_head: headSha })
      .set("Authorization", ctx.humanToken);

    expect(res.status).toBe(400);
  });
});
