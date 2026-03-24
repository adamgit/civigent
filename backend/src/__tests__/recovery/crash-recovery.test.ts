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
    // Create a proposal file in the committing directory
    const committingDir = join(ctx.rootDir, "proposals", "committing");
    await mkdir(committingDir, { recursive: true });

    const proposalData = {
      id: "stuck-proposal-1",
      writer: { id: "human-test", type: "human", displayName: "Test" },
      intent: "test stuck proposal",
      sections: [],
      created_at: new Date().toISOString(),
    };

    await writeFile(
      join(committingDir, "stuck-proposal-1.json"),
      JSON.stringify(proposalData, null, 2),
      "utf8",
    );

    // Verify file exists in committing
    const beforeFiles = await readdir(committingDir);
    expect(beforeFiles).toContain("stuck-proposal-1.json");

    // Run crash recovery
    const { detectAndRecoverCrash } = await import("../../storage/crash-recovery.js");
    await detectAndRecoverCrash();

    // After recovery, proposal should be moved to pending
    const pendingDir = join(ctx.rootDir, "proposals", 
"draft");
    const pendingFiles = await readdir(pendingDir).catch(() => []);
    expect(pendingFiles).toContain("stuck-proposal-1.json");

    // committing should be empty
    const afterCommitting = await readdir(committingDir).catch(() => []);
    expect(afterCommitting).not.toContain("stuck-proposal-1.json");
  });
});
