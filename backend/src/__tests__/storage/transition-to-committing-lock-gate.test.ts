/**
 * Claim 4 — proposal FSM locks are enforced at the COMMITTING boundary.
 *
 * `transitionToCommitting(...)` is the single mandatory exclusive-claim gate: EVERY
 * commit class (agent draft, human inprogress, CRDT-owned inprogress, transient
 * pending restore/overwrite/import/structural) passes through it. Before claiming
 * `committing` it asserts no OTHER proposal holds an exclusive lock
 * (`inprogress`/`committing`) on the proposal's full target set, with self-
 * exclusion so a proposal never blocks its own legal `→ committing` progress
 * (spec 12 §Transition Semantics). There is NO bypass.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import {
  createProposal,
  createTransientProposal,
  getOrCreateInProgressProposalForDocSession,
  transitionToInProgress,
  transitionToCommitting,
  readProposal,
} from "../../storage/proposal-repository.js";
import { ProposalLockConflictError } from "../../domain/proposal-fsm-locks.js";
import type { WriterIdentity, DocSessionId } from "../../types/shared.js";

const DOC = "doc.md";
const HUMAN_A: WriterIdentity = { type: "human", id: "human-a", displayName: "Alice" };
const HUMAN_B: WriterIdentity = { type: "human", id: "human-b", displayName: "Bob" };
const AGENT: WriterIdentity = { type: "agent", id: "agent-1", displayName: "Agent One" };
const AGENT_2: WriterIdentity = { type: "agent", id: "agent-2", displayName: "Agent Two" };
const DOCSESSION_WRITER: WriterIdentity = { type: "human", id: "human-live", displayName: "Live" };

const OVERVIEW = [{ doc_path: DOC, heading_path: ["Overview"] }];

describe("Claim 4: transitionToCommitting enforces the exclusive-claim lock gate", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("(a) an agent draft commit is BLOCKED by another proposal's inprogress claim", async () => {
    const holder = await createProposal(HUMAN_A, "human edit", OVERVIEW);
    expect((await transitionToInProgress(holder.id)).acquired).toBe(true);

    const challenger = await createProposal(AGENT, "agent edit", OVERVIEW);
    await expect(transitionToCommitting(challenger.id)).rejects.toBeInstanceOf(ProposalLockConflictError);

    // The blocked challenger is left untouched in its source status (no rename).
    expect((await readProposal(challenger.id)).status).toBe("draft");
  });

  it("(b) an agent draft commit is BLOCKED by another proposal's committing claim", async () => {
    // Park a holder in `committing` (it passes its own gate — it is the first).
    const holder = await createProposal(AGENT_2, "agent holder", OVERVIEW);
    await transitionToCommitting(holder.id);
    expect((await readProposal(holder.id)).status).toBe("committing");

    const challenger = await createProposal(AGENT, "agent edit", OVERVIEW);
    let err: unknown;
    try {
      await transitionToCommitting(challenger.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProposalLockConflictError);
    const conflict = (err as ProposalLockConflictError).result;
    expect(conflict.acquired).toBe(false);
    expect(conflict.conflicts[0].blockingProposalId).toBe(holder.id);
    expect(conflict.conflicts[0].blockingProposalStatus).toBe("committing");
    expect((await readProposal(challenger.id)).status).toBe("draft");
  });

  it("(c) a human inprogress -> committing SUCCEEDS through self-exclusion", async () => {
    const p = await createProposal(HUMAN_B, "human edit", OVERVIEW);
    expect((await transitionToInProgress(p.id)).acquired).toBe(true);

    await transitionToCommitting(p.id); // must not block itself
    expect((await readProposal(p.id)).status).toBe("committing");
  });

  it("(d) a CRDT-owned inprogress -> committing SUCCEEDS through self-exclusion", async () => {
    const { id } = await getOrCreateInProgressProposalForDocSession({
      docSessionId: "docsession-1" as DocSessionId,
      docPath: DOC,
      writer: DOCSESSION_WRITER,
      intent: "live edit",
      sections: OVERVIEW,
    });

    await transitionToCommitting(id); // self-excluded; its own inprogress claim must not block it
    expect((await readProposal(id)).status).toBe("committing");
  });

  it("(e) a transient pending proposal is BLOCKED if another proposal owns an overlapping target", async () => {
    const holder = await createProposal(HUMAN_A, "human edit", OVERVIEW);
    expect((await transitionToInProgress(holder.id)).acquired).toBe(true);

    // A transient pending op (restore/overwrite/import/document mutation all start
    // in `pending`) on the same section.
    const transient = await createTransientProposal(HUMAN_B, "restore overlap", OVERVIEW);
    await expect(transitionToCommitting(transient.id)).rejects.toBeInstanceOf(ProposalLockConflictError);
    expect((await readProposal(transient.id)).status).toBe("pending");
  });
});
