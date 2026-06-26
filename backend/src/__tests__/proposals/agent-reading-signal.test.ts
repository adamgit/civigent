/**
 * Backend `agent:reading` signal detection + broadcast (spec 06 §Signals).
 *
 * An authenticated AGENT's reads of content endpoints (sections, structure) emit
 * an `agent:reading` event carrying the actor + targeted heading paths — without
 * the agent declaring reading intent. Human reads do NOT emit it (it is an agent
 * signal), and meta reads (changes-since) do not signal content reading.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import { createSampleDocument, SAMPLE_DOC_PATH } from "../helpers/sample-content.js";
import type { WsServerEvent } from "../../types/shared.js";

function readingEvents(events: WsServerEvent[]): Array<Extract<WsServerEvent, { type: "agent:reading" }>> {
  return events.filter((e) => e.type === "agent:reading") as Array<Extract<WsServerEvent, { type: "agent:reading" }>>;
}

describe("agent:reading signal (spec 06)", () => {
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

  it("emits agent:reading with the actor + heading paths when an agent reads sections", async () => {
    ctx.wsEvents.length = 0;
    const res = await request(ctx.app)
      .get(`/api/canonical${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.agentToken);
    expect(res.status).toBe(200);

    const events = readingEvents(ctx.wsEvents);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[0];
    expect(ev.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(typeof ev.actor_id).toBe("string");
    expect(ev.heading_paths).toContainEqual(["Overview"]);
  });

  it("emits agent:reading when an agent reads document structure", async () => {
    ctx.wsEvents.length = 0;
    const res = await request(ctx.app)
      .get(`/api/canonical${SAMPLE_DOC_PATH}/structure`)
      .set("Authorization", ctx.agentToken);
    expect(res.status).toBe(200);
    expect(readingEvents(ctx.wsEvents).length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT emit agent:reading for a HUMAN read (it is an agent signal)", async () => {
    ctx.wsEvents.length = 0;
    const res = await request(ctx.app)
      .get(`/api/canonical${SAMPLE_DOC_PATH}/sections`)
      .set("Authorization", ctx.humanToken);
    expect(res.status).toBe(200);
    expect(readingEvents(ctx.wsEvents)).toHaveLength(0);
  });

  it("does NOT signal content reading for a meta read (changes-since)", async () => {
    ctx.wsEvents.length = 0;
    const res = await request(ctx.app)
      .get(`/api/canonical${SAMPLE_DOC_PATH}/changes-since`)
      .set("Authorization", ctx.agentToken);
    expect(res.status).toBe(200);
    expect(readingEvents(ctx.wsEvents)).toHaveLength(0);
  });
});
