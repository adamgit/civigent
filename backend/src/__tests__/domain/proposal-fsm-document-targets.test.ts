/**
 * Claim 6 / Claim 10 regression: document targets participate in proposal FSM
 * locking and conflict detection (spec 12 §Proposed Abstractions).
 *
 * Load-bearing invariants proven here:
 *  - a live-empty `create_document` claims a DOCUMENT target (not an empty set),
 *    so a document-level proposal still holds a lock/audit claim;
 *  - a document target conflicts with a section claim under the same document
 *    path, and vice versa;
 *  - a document target conflicts with another document claim on the same path;
 *  - section claims on OTHER documents do not conflict with a document target.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { checkProposalLocks } from "../../domain/proposal-fsm-locks.js";
import {
  createProposal,
  transitionToInProgress,
  readProposal,
} from "../../storage/proposal-repository.js";
import { mutateProposalContent } from "../../storage/mutate-proposal-content.js";
import { documentTargetRef } from "../../types/shared.js";
import type { WriterIdentity, ProposalTargetRef } from "../../types/shared.js";

const DOC = "doc.md";
const OTHER_DOC = "other.md";

const HUMAN_A: WriterIdentity = { type: "human", id: "human-a", displayName: "Alice" };
const HUMAN_B: WriterIdentity = { type: "human", id: "human-b", displayName: "Bob" };

const sectionTarget = (docPath: string, headingPath: string[]): ProposalTargetRef =>
  ({ kind: "section", doc_path: docPath, heading_path: headingPath });

describe("Claim 6/10: document targets in proposal FSM locking", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("a live-empty create_document claims a DOCUMENT target (not an empty manifest)", async () => {
    const { id } = await createProposal(HUMAN_A, "create empty doc");
    const { manifest } = await mutateProposalContent(id, { kind: "create_document", docPath: DOC });

    expect(manifest.sections).toHaveLength(0);
    expect(manifest.targets).toEqual([documentTargetRef(DOC)]);

    const reread = await readProposal(id);
    expect(reread.targets).toEqual([documentTargetRef(DOC)]);
  });

  it("a held document target blocks an overlapping SECTION claim (and vice versa)", async () => {
    // Holder claims the whole document via create_document, then locks it.
    const holder = await createProposal(HUMAN_A, "create doc");
    await mutateProposalContent(holder.id, { kind: "create_document", docPath: DOC });
    const acquired = await transitionToInProgress(holder.id);
    expect(acquired.acquired).toBe(true);

    // A challenger targeting a SECTION under that document is blocked.
    const challenger = await createProposal(HUMAN_B, "edit a section", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    const result = await checkProposalLocks({
      proposalId: challenger.id,
      targets: [sectionTarget(DOC, ["Overview"])],
    });
    expect(result.acquired).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.blockingProposalId).toBe(holder.id);

    // The reverse direction: a NEW document-level challenge is also blocked.
    const docChallenger = await createProposal(HUMAN_B, "rename the doc");
    const docResult = await checkProposalLocks({
      proposalId: docChallenger.id,
      targets: [documentTargetRef(DOC)],
    });
    expect(docResult.acquired).toBe(false);
    expect(docResult.conflicts).toHaveLength(1);
  });

  it("a held SECTION claim blocks an overlapping document target", async () => {
    const holder = await createProposal(HUMAN_A, "edit overview", [
      { doc_path: DOC, heading_path: ["Overview"] },
    ]);
    const acquired = await transitionToInProgress(holder.id);
    expect(acquired.acquired).toBe(true);

    const challenger = await createProposal(HUMAN_B, "delete the doc");
    const result = await checkProposalLocks({
      proposalId: challenger.id,
      targets: [documentTargetRef(DOC)],
    });
    expect(result.acquired).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.blockingProposalId).toBe(holder.id);
  });

  it("a section claim on a DIFFERENT document does not conflict with a document target", async () => {
    const holder = await createProposal(HUMAN_A, "edit other doc", [
      { doc_path: OTHER_DOC, heading_path: ["Intro"] },
    ]);
    const acquired = await transitionToInProgress(holder.id);
    expect(acquired.acquired).toBe(true);

    const challenger = await createProposal(HUMAN_B, "create doc");
    const result = await checkProposalLocks({
      proposalId: challenger.id,
      targets: [documentTargetRef(DOC)],
    });
    expect(result.acquired).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("self-exclusion: a document-target proposal can progress to inprogress without blocking itself", async () => {
    const holder = await createProposal(HUMAN_A, "create doc");
    await mutateProposalContent(holder.id, { kind: "create_document", docPath: DOC });
    const acquired = await transitionToInProgress(holder.id);
    expect(acquired.acquired).toBe(true);
    expect((await readProposal(holder.id)).status).toBe("inprogress");
  });
});
