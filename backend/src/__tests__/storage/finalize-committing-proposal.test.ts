/**
 * proposal-repository.finalizeCommittingProposal — startup-recovery finalize
 * helper (Area E). Promotes committing -> committed ONLY when the committing
 * meta.json already carries an enriched `committed_head` (crash between the
 * enriched-meta write and the atomic dir rename). Otherwise returns null and
 * leaves the proposal in committing (caller must rerun publication).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createProposal,
  readProposal,
  transitionToInProgress,
  transitionToCommitting,
  finalizeCommittingProposal,
  ProposalNotFoundError,
} from "../../storage/proposal-repository.js";
import { SAMPLE_DOC_PATH } from "../helpers/sample-content.js";

const writer = { id: "human-fin", type: "human" as const, displayName: "Fin", email: "fin@test.local" };

async function parkInCommitting(intent: string): Promise<string> {
  const { id } = await createProposal(
    writer,
    intent,
    [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "Body.\n" }],
  );
  await transitionToInProgress(id);
  await transitionToCommitting(id);
  return id;
}

describe("finalizeCommittingProposal", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("finalizes committing -> committed when committed_head is present", async () => {
    const id = await parkInCommitting("landed-but-unrenamed");
    const metaPath = join(ctx.rootDir, "proposals", "committing", id, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.committed_head = "b".repeat(40);
    meta.humanInvolvement_at_commit = {};
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

    const finalized = await finalizeCommittingProposal(id);

    expect(finalized).not.toBeNull();
    expect(finalized!.status).toBe("committed");
    expect((await readProposal(id)).status).toBe("committed");
    expect((finalized as { committed_head?: string }).committed_head).toBe("b".repeat(40));
  });

  it("returns null and leaves committing intact when committed_head is absent", async () => {
    const id = await parkInCommitting("not-yet-landed");

    const result = await finalizeCommittingProposal(id);

    expect(result).toBeNull();
    expect((await readProposal(id)).status).toBe("committing");
  });

  it("throws ProposalNotFoundError when no committing proposal exists for the id", async () => {
    await expect(finalizeCommittingProposal("does-not-exist")).rejects.toBeInstanceOf(ProposalNotFoundError);
  });
});
