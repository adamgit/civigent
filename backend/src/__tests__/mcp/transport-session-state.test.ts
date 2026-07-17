import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { createMcpRouter } from "../../mcp/transport.js";
import type { McpServer } from "../../mcp/server.js";
import type { McpSession } from "../../mcp/tool-registry.js";
import { activityLog } from "../../monitoring/activity-log.js";
import { getMonitoringRoot } from "../../storage/data-root.js";
import { authFor } from "../helpers/auth.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";

function createTransportApp(onSession?: (session: McpSession) => void) {
  const app = express();
  const server = {
    async handleMessage(message: any, _writer: unknown, session: McpSession) {
      onSession?.(session);
      return {
        jsonrpc: "2.0" as const,
        id: message.id,
        result: { sessionId: session.sessionId },
      };
    },
  } as unknown as McpServer;

  app.use("/mcp", createMcpRouter({ server }));
  return app;
}

describe("MCP transport session state", () => {
  let ctx: TempDataRootContext;

  beforeEach(async () => {
    ctx = await createTempDataRoot();
    await mkdir(getMonitoringRoot(), { recursive: true });
  });

  afterEach(async () => {
    await activityLog.flush("transport-shared-session", "delete-writer-A");
    await activityLog.flush("transport-shared-session", "delete-writer-B");
    await ctx.cleanup();
  });

  it("adopts a presented Mcp-Session-Id instead of replacing it", async () => {
    const seenSessionIds: Array<string | undefined> = [];
    const presentedSessionId = "client-presented-session";
    const app = createTransportApp((session) => {
      seenSessionIds.push(session.sessionId);
    });

    const res = await request(app)
      .post("/mcp")
      .set({
        Authorization: authFor("adoption-writer", "agent"),
        "Content-Type": "application/json",
        "Mcp-Session-Id": presentedSessionId,
      })
      .send({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBe(presentedSessionId);
    expect(res.body.result.sessionId).toBe(presentedSessionId);
    expect(seenSessionIds).toEqual([presentedSessionId]);
  });

  it("POST with no header mints a server session id", async () => {
    const app = createTransportApp();

    const res = await request(app)
      .post("/mcp")
      .set({ Authorization: authFor("mint-writer", "agent"), "Content-Type": "application/json" })
      .send({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeTruthy();
    expect(res.headers["mcp-session-id"].trim().length).toBeGreaterThan(0);
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
    ["oversized", "x".repeat(257)],
    ["non-visible-ASCII", "session id with spaces"],
    ["non-ASCII characters", "sessi\u00f3n-id"],
  ])("POST with a %s Mcp-Session-Id is rejected with 400, never adopted or minted over", async (_label, headerValue) => {
    let handled = false;
    const app = createTransportApp(() => {
      handled = true;
    });

    const res = await request(app)
      .post("/mcp")
      .set({
        Authorization: authFor("invalid-header-writer", "agent"),
        "Content-Type": "application/json",
        "Mcp-Session-Id": headerValue,
      })
      .send({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(res.status).toBe(400);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(handled).toBe(false);
  });

  it("DELETE with an empty Mcp-Session-Id is rejected with 400 (not a silent 204 no-op)", async () => {
    const app = createTransportApp();

    const res = await request(app)
      .delete("/mcp")
      .set({ Authorization: authFor("invalid-header-writer", "agent"), "Mcp-Session-Id": "" });

    expect(res.status).toBe(400);
  });

  it("unauthenticated DELETE returns 401 with the protected-resource challenge and flushes nothing", async () => {
    const app = createTransportApp();
    const sessionId = "unauth-delete-session";

    activityLog.record(sessionId, "unauth-delete-writer", "U", "read_doc", {});

    const res = await request(app)
      .delete("/mcp")
      .set({ "Mcp-Session-Id": sessionId });

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("oauth-protected-resource");
    // No deletion or flush ran — the buffer is untouched.
    expect(activityLog.has(sessionId, "unauth-delete-writer")).toBe(true);

    await activityLog.flush(sessionId, "unauth-delete-writer");
  });

  it("deleting one writer's session does not flush another writer's activity buffer", async () => {
    const app = createTransportApp();
    const sessionId = "transport-shared-session";
    const writerAToken = authFor("delete-writer-A", "agent");

    activityLog.record(sessionId, "delete-writer-A", "A", "read_doc", {});
    activityLog.record(sessionId, "delete-writer-B", "B", "read_doc", {});

    const res = await request(app)
      .delete("/mcp")
      .set({ Authorization: writerAToken, "Mcp-Session-Id": sessionId });

    expect(res.status).toBe(204);
    expect(activityLog.has(sessionId, "delete-writer-A")).toBe(false);
    expect(activityLog.has(sessionId, "delete-writer-B")).toBe(true);

    await activityLog.flush(sessionId, "delete-writer-B");
    expect(activityLog.has(sessionId, "delete-writer-B")).toBe(false);
  });
});
