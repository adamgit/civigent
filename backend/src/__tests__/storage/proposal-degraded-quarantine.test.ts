/**
 * Degraded-proposal quarantine + autofix (Option C).
 *
 * A proposal read leniently from a legacy missing-`targets` file is tagged
 * `degraded: ["missing-targets"]`. While degraded it must NOT acquire locks or
 * commit (its derived targets are lossy in the dangerous direction). The admin
 * autofix re-derives `targets` + clears the marker, after which it commits
 * normally. Mirrors the on-disk legacy shape by stripping the `targets` key from
 * a freshly-created proposal's meta.json.
 */

import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createProposal,
  readProposal,
  transitionToInProgress,
  transitionToCommitting,
  listDegradedProposals,
} from "../../storage/proposal-repository.js";
import { getProposalsDraftRoot, getProposalsCommittedRoot } from "../../storage/data-root.js";
import { autofixProposalDefect } from "../../api/application/admin.js";

const HUMAN = { id: "human-q", type: "human" as const, displayName: "Q", email: "q@test.local" };
const AGENT = { id: "agent-q", type: "agent" as const, displayName: "Agent Q" };
const SECTIONS = [{ doc_path: "/q/doc.md", heading_path: ["Overview"] }];

let ctx: TempDataRootContext;
afterEach(async () => {
  await ctx?.cleanup();
});

/** Rewrite a draft proposal's meta.json to the legacy shape (no `targets` key). */
async function stripTargetsKey(id: string): Promise<void> {
  const metaPath = join(getProposalsDraftRoot(), id, "meta.json");
  const obj = JSON.parse(await readFile(metaPath, "utf8"));
  delete obj.targets;
  await writeFile(metaPath, JSON.stringify(obj, null, 2), "utf8");
}

describe("degraded proposal quarantine + autofix", () => {
  it("reads as degraded, refuses lock/commit, then commits after autofix", async () => {
    ctx = await createTempDataRoot();

    // A human proposal for the lock-acquisition refusal.
    const human = await createProposal(HUMAN, "legacy human", SECTIONS);
    await stripTargetsKey(human.id);

    const decoded = await readProposal(human.id);
    expect(decoded.degraded).toEqual(["missing-targets"]);
    // Targets are still derived (non-empty), so the empty-targets guard passes and
    // the degraded guard is what blocks the transition.
    expect(decoded.targets.length).toBeGreaterThan(0);

    await expect(transitionToInProgress(human.id)).rejects.toThrow(/degraded/);

    // An agent proposal for the commit refusal + autofix-then-commit path.
    const agent = await createProposal(AGENT, "legacy agent", SECTIONS);
    await stripTargetsKey(agent.id);

    expect((await readProposal(agent.id)).degraded).toEqual(["missing-targets"]);
    await expect(transitionToCommitting(agent.id)).rejects.toThrow(/degraded/);

    // Autofix clears the marker and re-derives targets.
    const result = await autofixProposalDefect(agent.id, "missing-targets");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.degraded).toBeUndefined();
      expect(result.proposal.targets.length).toBeGreaterThan(0);
    }

    // The on-disk proposal is now healthy and commits normally.
    expect((await readProposal(agent.id)).degraded).toBeUndefined();
    await expect(transitionToCommitting(agent.id)).resolves.toMatchObject({ status: "committing" });
  });

  it("listDegradedProposals returns degraded non-terminal proposals and excludes a legacy committed one", async () => {
    ctx = await createTempDataRoot();

    // A degraded draft — created, then stripped to the legacy shape.
    const draft = await createProposal(HUMAN, "legacy draft", SECTIONS);
    await stripTargetsKey(draft.id);

    // A healthy draft — must NOT be returned.
    const healthy = await createProposal(HUMAN, "healthy draft", SECTIONS);

    // A legacy COMMITTED proposal on disk (missing `targets`). Terminal: it is
    // neither scanned by the degradable-only query nor tagged by the decoder, so
    // it must be absent from the result.
    const committedId = "prop-legacy-committed";
    const committedDir = join(getProposalsCommittedRoot(), committedId);
    await mkdir(committedDir, { recursive: true });
    await writeFile(
      join(committedDir, "meta.json"),
      JSON.stringify({
        id: committedId,
        writer: AGENT,
        intent: "legacy committed",
        sections: SECTIONS,
        created_at: "2025-01-01T00:00:00.000Z",
        committed_head: "abc123",
        humanInvolvement_at_commit: {},
      }, null, 2),
      "utf8",
    );

    const degraded = await listDegradedProposals();
    const ids = degraded.map((p) => p.id);
    expect(ids).toContain(draft.id);
    expect(ids).not.toContain(healthy.id);
    expect(ids).not.toContain(committedId);
    expect(degraded.every((p) => (p.degraded ?? []).length > 0)).toBe(true);
  });

  it("autofix on a non-degraded proposal is a 409 no-op", async () => {
    ctx = await createTempDataRoot();
    const healthy = await createProposal(AGENT, "healthy", SECTIONS);
    const result = await autofixProposalDefect(healthy.id, "missing-targets");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("autofix with an unknown detector id is a 404", async () => {
    ctx = await createTempDataRoot();
    const p = await createProposal(AGENT, "x", SECTIONS);
    const result = await autofixProposalDefect(p.id, "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});
