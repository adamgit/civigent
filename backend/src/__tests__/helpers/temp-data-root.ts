import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitRepoReady } from "../../storage/git-repo.js";

export type TempDataRootContext = {
  rootDir: string;
  contentDir: string;
  proposalsDir: string;
  proposalsInflightDir: string;
  proposalsCompleteDir: string;
  proposalsCancelledDir: string;
  draftsDir: string;
  previousKsDataRoot: string | undefined;
  cleanup: () => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createTempDataRoot(): Promise<TempDataRootContext> {
  const rootDir = await mkdtemp(join(tmpdir(), "ks-data-root-"));
  const contentDir = join(rootDir, "content");
  const proposalsDir = join(rootDir, "proposals");
  const proposalsInflightDir = join(proposalsDir, "inflight");
  const proposalsCompleteDir = join(proposalsDir, "complete");
  const proposalsCancelledDir = join(proposalsDir, "cancelled");
  const draftsDir = join(rootDir, "drafts");

  await mkdir(contentDir, { recursive: true });
  await mkdir(proposalsInflightDir, { recursive: true });
  await mkdir(proposalsCompleteDir, { recursive: true });
  await mkdir(proposalsCancelledDir, { recursive: true });
  await mkdir(draftsDir, { recursive: true });
  await ensureGitRepoReady(rootDir);

  const previousKsDataRoot = process.env.KS_DATA_ROOT;
  process.env.KS_DATA_ROOT = rootDir;

  return {
    rootDir,
    contentDir,
    proposalsDir,
    proposalsInflightDir,
    proposalsCompleteDir,
    proposalsCancelledDir,
    draftsDir,
    previousKsDataRoot,
    cleanup: async () => {
      if (previousKsDataRoot === undefined) {
        delete process.env.KS_DATA_ROOT;
      } else {
        process.env.KS_DATA_ROOT = previousKsDataRoot;
      }

      // Snapshot/background tasks may still be writing briefly after tests
      // complete; retry a few times on transient filesystem contention.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(rootDir, { recursive: true, force: true });
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOTEMPTY" && code !== "EBUSY") {
            throw error;
          }
          await sleep(25 * (attempt + 1));
        }
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  };
}

export async function withTempDataRoot<T>(
  run: (ctx: TempDataRootContext) => Promise<T>,
): Promise<T> {
  const ctx = await createTempDataRoot();
  try {
    return await run(ctx);
  } finally {
    await ctx.cleanup();
  }
}
