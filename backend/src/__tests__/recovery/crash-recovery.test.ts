/**
 * Crash recovery — narrowed proposal-FSM + git-integrity contract (Area E).
 *
 * Recovery:
 *   - discards `pending` proposals (transient debris);
 *   - finishes-forward `committing` proposals (NEVER rolls back):
 *       • finalizes one whose meta.json already carries `committed_head`;
 *       • reruns proposal-to-canonical when no `committed_head`;
 *   - leaves `inprogress` proposals untouched (durable live state);
 *   - accepts a dirty tree only as the by-product of a completed committing
 *     proposal, otherwise fails startup with a maintainer report.
 *
 * There is NO session-file recovery.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import {
  createProposal,
  createTransientProposal,
  readProposal,
  transitionToInProgress,
  transitionToCommitting,
} from "../../storage/proposal-repository.js";
import { detectAndRecoverCrash } from "../../storage/crash-recovery.js";

const humanWriter = { id: "human-test", type: "human" as const, displayName: "Human Test", email: "human@test.local" };

describe("Crash Recovery — proposal FSM + git integrity", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await createSampleDocument(ctx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("discards pending proposals as transient debris", async () => {
    const { id } = await createTransientProposal(humanWriter, "transient debris");
    const pendingDir = join(ctx.rootDir, "proposals", "pending", id);
    expect((await readdir(join(ctx.rootDir, "proposals", "pending")))).toContain(id);

    const result = await detectAndRecoverCrash(ctx.rootDir);

    expect(result.pendingDiscarded).toBe(1);
    expect(result.recovered).toBe(true);
    await expect(readdir(pendingDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reruns a committing proposal with no committed_head (publishes from content/)", async () => {
    // Build a real human proposal and park it in committing (interrupted publish,
    // canonical commit not yet landed → no committed_head).
    const { id } = await createProposal(
      humanWriter,
      "interrupted publish",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Recovered overview.\n" }],
    );
    await transitionToInProgress(id);
    await transitionToCommitting(id);
    expect((await readProposal(id)).status).toBe("committing");

    const result = await detectAndRecoverCrash(ctx.rootDir);

    expect(result.committingRerun).toContain(id);
    expect(result.committingFinalized).not.toContain(id);
    // Finish-forward → committed, never rolled back to draft/inprogress.
    expect((await readProposal(id)).status).toBe("committed");
  });

  it("finalizes a committing proposal whose meta.json already carries committed_head", async () => {
    const { id } = await createProposal(
      humanWriter,
      "landed but un-renamed",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Already landed.\n" }],
    );
    await transitionToInProgress(id);
    await transitionToCommitting(id);

    // Simulate crash between the enriched-meta write and the atomic dir rename:
    // committed_head is present on the committing meta.json.
    const metaPath = join(ctx.rootDir, "proposals", "committing", id, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.committed_head = "a".repeat(40);
    meta.humanInvolvement_at_commit = {};
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

    const result = await detectAndRecoverCrash(ctx.rootDir);

    expect(result.committingFinalized).toContain(id);
    expect(result.committingRerun).not.toContain(id);
    const committed = await readProposal(id);
    expect(committed.status).toBe("committed");
    // No canonical re-absorb happened — committed_head is preserved verbatim.
    expect((committed as { committed_head?: string }).committed_head).toBe("a".repeat(40));
  });

  it("never rolls a committing proposal back to draft or inprogress", async () => {
    const { id } = await createProposal(
      humanWriter,
      "no rollback",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "No rollback.\n" }],
    );
    await transitionToInProgress(id);
    await transitionToCommitting(id);

    await detectAndRecoverCrash(ctx.rootDir);

    const status = (await readProposal(id)).status;
    expect(status).not.toBe("draft");
    expect(status).not.toBe("inprogress");
    expect(status).toBe("committed");
    // committing/ directory drained.
    const committing = await readdir(join(ctx.rootDir, "proposals", "committing")).catch(() => []);
    expect(committing).not.toContain(id);
  });

  it("leaves inprogress proposals untouched as durable live state", async () => {
    const { id } = await createProposal(
      humanWriter,
      "live edit",
      [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Live edit.\n" }],
    );
    await transitionToInProgress(id);
    expect((await readProposal(id)).status).toBe("inprogress");

    const result = await detectAndRecoverCrash(ctx.rootDir);

    expect((await readProposal(id)).status).toBe("inprogress");
    expect(result.committingFinalized).toHaveLength(0);
    expect(result.committingRerun).toHaveLength(0);
  });

  it("clean state with nothing to recover reports recovered=false", async () => {
    const result = await detectAndRecoverCrash(ctx.rootDir);
    expect(result.recovered).toBe(false);
    expect(result.pendingDiscarded).toBe(0);
    expect(result.committingFinalized).toHaveLength(0);
    expect(result.committingRerun).toHaveLength(0);
  });
});
