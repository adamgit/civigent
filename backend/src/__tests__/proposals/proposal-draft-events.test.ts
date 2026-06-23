/**
 * `proposal:draft` events (spec 02 §3 API/events; spec 06 signals).
 *
 * The draft event is what lets humans SEE a targeted draft's intent before locks
 * are acquired. It must fire on creation and on draft section/scope updates,
 * carry the payload humans need (writer identity + intent + targeted heading
 * paths), and be keyed by `proposal_id` so a UI replaces (idempotently) rather
 * than duplicating the indicator across re-emits.
 *
 * Do not settle for only `section:blocked`/`section:unblocked` here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import { authFor } from "../helpers/auth.js";
import type { WsServerEvent } from "../../types/shared.js";

type DraftEvent = Extract<WsServerEvent, { type: "proposal:draft" }>;

function draftEvents(events: WsServerEvent[], proposalId: string, docPath: string): DraftEvent[] {
  return events.filter(
    (e): e is DraftEvent =>
      e.type === "proposal:draft" && e.proposal_id === proposalId && e.doc_path === docPath,
  );
}

describe("proposal:draft events (spec 02 §3)", () => {
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

  it("emits proposal:draft on creation with the targeted-intent payload", async () => {
    const token = authFor("draft-author", "human");
    const create = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", token)
      .send({
        intent: "Draft intent A",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "draft a\n" }],
      });
    expect(create.status).toBe(201);
    const proposalId = create.body.proposal_id;

    const events = draftEvents(ctx.wsEvents, proposalId, SAMPLE_DOC_PATH);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[events.length - 1]!;
    expect(ev.heading_paths).toContainEqual(["Overview"]);
    expect(ev.writer_id).toBe("draft-author");
    expect(ev.writer_display_name).toBe("draft-author");
    expect(ev.intent).toBe("Draft intent A");
  });

  it("re-emits proposal:draft on a draft scope/intent update, keyed by the SAME proposal_id (idempotent indicator)", async () => {
    const token = authFor("draft-author-2", "human");
    const create = await request(ctx.app)
      .post("/api/proposals")
      .set("Authorization", token)
      .send({
        intent: "Initial intent",
        sections: [{ doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"], content: "x\n" }],
      });
    expect(create.status).toBe(201);
    const proposalId = create.body.proposal_id;
    const creationEvents = draftEvents(ctx.wsEvents, proposalId, SAMPLE_DOC_PATH);
    expect(creationEvents.length).toBeGreaterThanOrEqual(1);

    ctx.wsEvents.length = 0;

    // Update the draft: broaden scope to two sections and change the intent.
    const update = await request(ctx.app)
      .put(`/api/proposals/${proposalId}`)
      .set("Authorization", token)
      .send({
        intent: "Broadened intent",
        targets: [
          { doc_path: SAMPLE_DOC_PATH, heading_path: ["Overview"] },
          { doc_path: SAMPLE_DOC_PATH, heading_path: ["Timeline"] },
        ],
      });
    expect(update.status).toBe(200);

    const updateEvents = draftEvents(ctx.wsEvents, proposalId, SAMPLE_DOC_PATH);
    expect(updateEvents.length).toBeGreaterThanOrEqual(1);
    const ev = updateEvents[updateEvents.length - 1]!;
    // Same proposal_id (stable key) — a UI replaces the indicator, not duplicates it.
    expect(ev.proposal_id).toBe(proposalId);
    // Payload reflects the UPDATED scope and intent.
    expect(ev.intent).toBe("Broadened intent");
    expect(ev.heading_paths).toContainEqual(["Overview"]);
    expect(ev.heading_paths).toContainEqual(["Timeline"]);
  });
});
