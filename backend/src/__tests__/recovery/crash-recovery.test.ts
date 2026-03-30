import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

describe("Crash Recovery", () => {
  let ctx: TempDataRootContext;

  beforeAll(async () => {
    ctx = await createTempDataRoot();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("proposals stuck in committing/ are recovered on startup", async () => {
    const proposalId = "stuck-proposal-1";

    // Create the committing directory with proper {id}/meta.json structure
    const committingDir = join(ctx.rootDir, "proposals", "committing");
    const proposalSubDir = join(committingDir, proposalId);
    await mkdir(proposalSubDir, { recursive: true });

    // Also ensure draft/ directory exists (recovery target)
    const draftDir = join(ctx.rootDir, "proposals", "draft");
    await mkdir(draftDir, { recursive: true });

    const proposalData = {
      id: proposalId,
      writer: { id: "human-test", type: "human", displayName: "Test" },
      intent: "test stuck proposal",
      sections: [],
      created_at: new Date().toISOString(),
    };

    await writeFile(
      join(proposalSubDir, "meta.json"),
      JSON.stringify(proposalData, null, 2),
      "utf8",
    );

    // Verify directory exists in committing
    const beforeEntries = await readdir(committingDir);
    expect(beforeEntries).toContain(proposalId);

    // Run crash recovery
    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    await detectAndRecoverCrash();

    // After recovery, proposal directory should be moved to draft
    const draftEntries = await readdir(draftDir).catch(() => []);
    expect(draftEntries).toContain(proposalId);

    // committing should be empty
    const afterCommitting = await readdir(committingDir).catch(() => []);
    expect(afterCommitting).not.toContain(proposalId);
  });
});
