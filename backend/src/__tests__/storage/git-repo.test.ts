import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureGitRepoReady, getHeadSha, gitExec } from "../../storage/git-repo.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument } from "../helpers/sample-content.js";

describe("git-repo", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
    // createTempDataRoot already calls ensureGitRepoReady, but we need
    // a commit for getHeadSha. Create a sample doc to get one.
    await createSampleDocument(ctx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("ensureGitRepoReady initializes git repo (creates .git dir)", async () => {
    const { access } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // The repo was already initialized by createTempDataRoot; verify .git exists
    await expect(access(join(ctx.rootDir, ".git"))).resolves.toBeUndefined();

    // Calling ensureGitRepoReady again should not throw (idempotent)
    await expect(ensureGitRepoReady(ctx.rootDir)).resolves.toBeUndefined();
  });

  it("getHeadSha returns current HEAD SHA (40-char hex string)", async () => {
    const sha = await getHeadSha(ctx.rootDir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("gitExec runs arbitrary git commands (e.g. git status)", async () => {
    const output = await gitExec(["status", "--porcelain"], ctx.rootDir);
    // Output is a string (possibly empty if working tree is clean)
    expect(typeof output).toBe("string");
  });
});
