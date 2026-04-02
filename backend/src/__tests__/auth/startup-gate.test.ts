import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";
import { createTempDataRoot, type TempDataRootContext } from "../helpers/temp-data-root.js";
import { setSystemReady, _resetSystemReadyForTesting } from "../../startup-state.js";
import type { Express } from "express";

describe("Startup gate — 503 during recovery", () => {
  let app: Express;
  let dataCtx: TempDataRootContext;

  beforeAll(async () => {
    dataCtx = await createTempDataRoot();
    app = createApp();
  });

  afterAll(async () => {
    setSystemReady();
    await dataCtx.cleanup();
  });

  it("returns 503 on data endpoints when system is not ready", async () => {
    _resetSystemReadyForTesting();

    const res = await request(app).get("/api/documents/tree");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("system_starting");

    // Restore
    setSystemReady();
  });

  it("/api/auth/* is exempt from startup gate", async () => {
    _resetSystemReadyForTesting();

    const res = await request(app).get("/api/auth/methods");
    expect(res.status).toBe(200);

    setSystemReady();
  });
});

describe("Startup gate — MCP tool calls blocked during recovery", () => {
  afterEach(() => {
    setSystemReady();
  });

  it("MCP tools/call returns error when system is not ready", async () => {
    _resetSystemReadyForTesting();

    const { McpServer } = await import("../../mcp/server.js");
    const { ToolRegistry } = await import("../../mcp/tool-registry.js");

    const registry = new ToolRegistry();
    const server = new McpServer({ registry });

    const writer = { id: "test", type: "human" as const, displayName: "Test" };
    const session = {};

    const toolCallMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });

    const response = await server.handleRawMessage(toolCallMsg, writer, session);
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toContain("starting up");
  });

  it("MCP initialize is NOT blocked during startup", async () => {
    _resetSystemReadyForTesting();

    const { McpServer } = await import("../../mcp/server.js");
    const { ToolRegistry } = await import("../../mcp/tool-registry.js");

    const registry = new ToolRegistry();
    const server = new McpServer({ registry });

    const writer = { id: "test", type: "human" as const, displayName: "Test" };
    const session = {};

    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    const response = await server.handleRawMessage(initMsg, writer, session);
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!);
    // Should NOT have an error — initialize is exempt
    expect(parsed.error).toBeUndefined();
    expect(parsed.result).toBeDefined();
    expect(parsed.result.protocolVersion).toBeDefined();
  });
});
