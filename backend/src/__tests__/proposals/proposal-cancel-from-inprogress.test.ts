/**
 * Cancel-from-`inprogress` (spec 02 §3 Invariant 5; spec 12 lock release).
 *
 * Withdrawing an `inprogress` human proposal must:
 *  - release its exclusive FSM locks so the previously-locked sections become
 *    acquirable again (a FUNCTIONAL release, not just an event);
 *  - emit the `proposal:withdrawn` event (and the `section:unblocked` events,
 *    already covered in `section-block-state-events.test.ts` (b2));
 *  - record the selected withdrawal metadata (the withdrawal reason) on the
 *    stored proposal.
 *
 * Do not treat absence of these events / lock release as acceptable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import { readProposal } from "../../storage/proposal-repository.js";
import type { WsServerEvent } from "../../types/shared.js";

async function lockOverview(ctx: TestServerContext, token: string): Promise<string> {
  const create = await request(ctx.app)
    .post("/api/proposals")
    .set("Authorization", token)
    .send({ intent: "Lock overview", sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "edit\n" }] });
  expect(create.status).toBe(201);
  const id = create.body.proposal_id as string;
  const acquire = await request(ctx.app)
    .post(`/api/proposals/${id}/acquire-locks`)
    .set("Authorization", token);
  expect(acquire.body.acquired).toBe(true);
  return id;
}

describe("cancel from inprogress (spec 02 §3 Invariant 5; spec 12)", () => {
  let ctx: TestServerContext;
  let prevAuthMode: string | undefined;

  beforeEach(async () => {
    prevAuthMode = process.env.KS_AUTH_MODE;
    process.env.KS_AUTH_MODE = "oidc";
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
    if (prevAuthMode === undefined) delete process.env.KS_AUTH_MODE;
    else process.env.KS_AUTH_MODE = prevAuthMode;
  });

  it("releases locks, emits proposal:withdrawn, and records the withdrawal reason", async () => {
    const ownerToken = authFor("cancel-owner", "human");
    const proposalId = await lockOverview(ctx, ownerToken);
    ctx.wsEvents.length = 0;

    const cancel = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/cancel`)
      .set("Authorization", ownerToken)
      .send({ reason: "no longer needed" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("withdrawn");

    // proposal:withdrawn event emitted for the affected document + section.
    const withdrawn = ctx.wsEvents.filter(
      (e: WsServerEvent) => e.type === "proposal:withdrawn",
    ) as Array<Extract<WsServerEvent, { type: "proposal:withdrawn" }>>;
    const forDoc = withdrawn.find((e) => e.doc_path === SAMPLE_DOC_PATH);
    expect(forDoc).toBeDefined();
    expect(forDoc!.proposal_id).toBe(proposalId);
    expect(forDoc!.heading_paths).toContainEqual(["Overview"]);

    // Withdrawal metadata recorded on the stored proposal.
    const stored = await readProposal(proposalId);
    expect(stored.status).toBe("withdrawn");
    expect((stored as { withdrawal_reason?: string }).withdrawal_reason).toBe("no longer needed");

    // FUNCTIONAL lock release: a different writer can now acquire Overview.
    const otherToken = authFor("cancel-successor", "human");
    const successor = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", otherToken)
      .send({ intent: "Take over overview", sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "mine\n" }] });
    expect(successor.status).toBe(201);
    const acquire = await request(ctx.app)
      .post(`/api/proposals/${successor.body.proposal_id}/acquire-locks`)
      .set("Authorization", otherToken);
    expect(acquire.status).toBe(200);
    expect(acquire.body.acquired).toBe(true);
    expect(acquire.body.status).toBe("inprogress");
  });
});
