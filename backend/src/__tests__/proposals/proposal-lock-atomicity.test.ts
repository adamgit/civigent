/**
 * Lock atomicity and preconditions (spec 02 §3 Invariant 3; spec 12 §Proposal
 * FSM locking).
 *
 * Coverage split across files (to avoid duplication):
 *  - ownership (403), human-writer-type (409), already-inprogress (409), 404,
 *    and the single-section conflict payload → `proposal-acquire-locks.test.ts`;
 *  - non-empty effective intent precondition → `proposal-human-draft-semantics.test.ts`.
 *
 * THIS file pins the atomicity properties those do not:
 *  - select-at-least-one-section precondition;
 *  - ALL-OR-NOTHING acquisition: a multi-target draft with ONE conflicting target
 *    acquires NOTHING (the free target is left unlocked), the conflict payload
 *    names only the conflicting target, and the proposal's prior `draft` state is
 *    preserved.
 *
 * NOTE (spec/impl): "missing/tombstoned/stale target" rejection is NOT a V1
 * acquire-locks precondition — the lock path checks only conflicts against other
 * proposals' declared targets (no target-existence/tombstone validation in
 * spec 12 or `checkProposalLocks`). Recorded in assumptions.md; not tested here.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import { createProposal, transitionToInProgress } from "../../storage/proposal-repository.js";

describe("lock atomicity and preconditions (spec 12)", () => {
  let ctx: TestServerContext;
  let prevAuthMode: string | undefined;

  beforeAll(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterAll(async () => {
    await ctx.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("refuses to acquire locks for a draft with no selected sections", async () => {
    const create = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", ctx.humanToken)
      .send({ intent: "No sections selected", sections: [] });
    expect(create.status).toBe(201);

    const res = await request(ctx.app)
      .post(`/api/proposals/${create.body.proposal_id}/acquire-locks`)
      .set("Authorization", ctx.humanToken);
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.text).toMatch(/select at least one section/i);
  });

  it("acquires ALL-OR-NOTHING: one conflicting target fails the whole acquisition, leaves the free target unlocked, and preserves draft state", async () => {
    // A competing inprogress proposal exclusively holds Timeline.
    const competingWriter = { type: "human" as const, id: "atomicity-competitor", displayName: "Competitor" };
    const { id: competingId } = await createProposal(competingWriter, "Holds timeline", [
      { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] },
    ]);
    const lock = await transitionToInProgress(competingId);
    expect(lock.acquired).toBe(true);

    // Subject human draft claims BOTH Overview (free) and Timeline (conflicting).
    const subjectWriter = authFor("atomicity-subject", "human");
    const create = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", subjectWriter)
      .send({
        intent: "Edit overview and timeline",
        sections: [
          { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "o\n" },
          { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"], content: "t\n" },
        ],
      });
    expect(create.status).toBe(201);
    const subjectId = create.body.proposal_id;

    // Acquisition fails atomically — conflict names ONLY Timeline.
    const acquire = await request(ctx.app)
      .post(`/api/proposals/${subjectId}/acquire-locks`)
      .set("Authorization", subjectWriter);
    expect(acquire.status).toBe(200);
    expect(acquire.body.acquired).toBe(false);
    expect(acquire.body.conflicts).toHaveLength(1);
    expect(acquire.body.conflicts[0].target.heading_path).toEqual(["Timeline"]);
    expect(acquire.body.conflicts[0].blockingProposalId).toBe(competingId);

    // Prior state preserved: the subject is still a draft.
    const read = await request(ctx.app)
      .get(`/api/proposals/${subjectId}`)
      .set("Authorization", subjectWriter);
    expect(read.status).toBe(200);
    expect(read.body.proposal.status).toBe("draft");

    // The free target (Overview) was NOT partially locked: a THIRD proposal can
    // still claim Overview and acquire it — proving nothing was acquired.
    const thirdWriter = authFor("atomicity-third", "human");
    const third = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", thirdWriter)
      .send({
        intent: "Claim overview only",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "o2\n" }],
      });
    expect(third.status).toBe(201);
    const thirdAcquire = await request(ctx.app)
      .post(`/api/proposals/${third.body.proposal_id}/acquire-locks`)
      .set("Authorization", thirdWriter);
    expect(thirdAcquire.status).toBe(200);
    expect(thirdAcquire.body.acquired).toBe(true);
    expect(thirdAcquire.body.status).toBe("inprogress");
  });
});
