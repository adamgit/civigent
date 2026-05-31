/**
 * MW-5: section block-state event emission (`section:blocked` /
 * `section:unblocked` / `section:gone`) on the JSON application WebSocket.
 *
 * These drive the REAL application-layer entry points (the proposal acquire-locks
 * / commit / cancel routes and the section-delete route) with the test server's
 * captured `onWsEvent` spy (`ctx.wsEvents`). They fail if the emit calls are
 * removed:
 *  - (a) a competing proposal acquiring an exclusive FSM lock on section X emits
 *        `section:blocked` for X with X's real CRDT fragment_key;
 *  - (b) committing / withdrawing that proposal emits `section:unblocked` for X;
 *  - (c) deleting a section emits `section:gone` with the section's fragment_key.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import type { WsServerEvent } from "../../types/shared.js";

// The Overview/Timeline section files in the sample doc produce these CRDT
// fragment keys (`section::` + sectionFileId).
const OVERVIEW_FRAGMENT_KEY = "section::overview";
const TIMELINE_FRAGMENT_KEY = "section::timeline";

function blockStateEvents(
  events: WsServerEvent[],
  kind: "section:blocked" | "section:unblocked" | "section:gone",
): Array<Extract<WsServerEvent, { type: typeof kind }>> {
  return events.filter((e) => e.type === kind) as Array<Extract<WsServerEvent, { type: typeof kind }>>;
}

async function createInProgressProposalOnOverview(ctx: TestServerContext): Promise<string> {
  const createRes = await request(ctx.app)
    .post("/api/proposals")
    .set("Authorization", ctx.humanToken)
    .send({
      intent: "Lock Overview",
      sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "edited\n" }],
    });
  expect(createRes.body.status).toBe("draft");
  const proposalId = createRes.body.proposal_id as string;

  const acquireRes = await request(ctx.app)
    .post(`/api/proposals/${proposalId}/acquire-locks`)
    .set("Authorization", ctx.humanToken);
  expect(acquireRes.status).toBe(200);
  expect(acquireRes.body.acquired).toBe(true);
  return proposalId;
}

describe("MW-5: section block-state events", () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("(a) acquiring an exclusive lock emits section:blocked with the real fragment_key", async () => {
    await createInProgressProposalOnOverview(ctx);

    const blocked = blockStateEvents(ctx.wsEvents, "section:blocked");
    const overview = blocked.find((e) => e.fragment_key === OVERVIEW_FRAGMENT_KEY);
    expect(overview).toBeDefined();
    expect(overview!.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(overview!.heading_path).toEqual(["Overview"]);
  });

  it("(b1) committing the proposal emits section:unblocked", async () => {
    const proposalId = await createInProgressProposalOnOverview(ctx);
    ctx.wsEvents.length = 0;

    const commitRes = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/commit`)
      .set("Authorization", ctx.humanToken);
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.status).toBe("committed");

    const unblocked = blockStateEvents(ctx.wsEvents, "section:unblocked");
    const overview = unblocked.find((e) => e.fragment_key === OVERVIEW_FRAGMENT_KEY);
    expect(overview).toBeDefined();
    expect(overview!.heading_path).toEqual(["Overview"]);
  });

  it("(b2) withdrawing the proposal emits section:unblocked", async () => {
    const proposalId = await createInProgressProposalOnOverview(ctx);
    ctx.wsEvents.length = 0;

    const cancelRes = await request(ctx.app)
      .post(`/api/proposals/${proposalId}/cancel`)
      .set("Authorization", ctx.humanToken)
      .send({ reason: "changed mind" });
    expect(cancelRes.status).toBe(200);

    const unblocked = blockStateEvents(ctx.wsEvents, "section:unblocked");
    const overview = unblocked.find((e) => e.fragment_key === OVERVIEW_FRAGMENT_KEY);
    expect(overview).toBeDefined();
    expect(overview!.heading_path).toEqual(["Overview"]);
  });

  it("(c) deleting a section emits section:gone with its fragment_key", async () => {
    ctx.wsEvents.length = 0;

    const delRes = await request(ctx.app)
      .delete(`/api/documents${SAMPLE_DOC_PATH}/sections/${encodeURIComponent("Timeline")}`)
      .set("Authorization", ctx.humanToken);
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);

    const gone = blockStateEvents(ctx.wsEvents, "section:gone");
    const timeline = gone.find((e) => e.fragment_key === TIMELINE_FRAGMENT_KEY);
    expect(timeline).toBeDefined();
    expect(timeline!.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(timeline!.heading_path).toEqual(["Timeline"]);
  });
});
