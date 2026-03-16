/**
 * MCP module entry point.
 *
 * Exports the factory function to create a fully wired MCP Express router.
 * Tool registration happens here — add new tools by importing and calling
 * their register function on the registry.
 */

export { ToolRegistry, type ToolContext, type ToolHandler, type McpSession, jsonToolResult, textToolResult } from "./tool-registry.js";
export { McpServer, type McpServerOptions } from "./server.js";
export { createMcpRouter, type McpTransportOptions } from "./transport.js";
export {
  type McpToolDefinition,
  type McpToolCallResult,
  makeToolResult,
  makeToolErrorResult,
} from "./protocol.js";

import { ToolRegistry } from "./tool-registry.js";
import { McpServer } from "./server.js";
import { createMcpRouter } from "./transport.js";
import { registerFilesystemTools, registerPlanChangesTool } from "./tools/filesystem.js";
import { registerCollaborationTools } from "./tools/collaboration.js";
import { registerStructuralTools } from "./tools/structural.js";
import type { WsServerEvent } from "../types/shared.js";
import express from "express";

export type McpTier = 1 | 2 | 3;

/**
 * Create a fully configured MCP router ready to mount on an Express app.
 *
 * tier 1 → registerFilesystemTools (read, write, list, delete, move)
 * tier 2 → registerFilesystemTools + registerPlanChangesTool
 * tier 3 → registerCollaborationTools + registerStructuralTools
 *
 * Usage:
 *   app.use("/mcp/tier1", createKnowledgeStoreMcpRouter({ tier: 1, onWsEvent }));
 */
export function createKnowledgeStoreMcpRouter(options?: {
  tier?: McpTier;
  onWsEvent?: (event: WsServerEvent) => void;
}): express.Router {
  const tier = options?.tier ?? 3;
  const registry = new ToolRegistry();

  if (tier === 1 || tier === 2) {
    registerFilesystemTools(registry);
    if (tier === 2) {
      registerPlanChangesTool(registry);
    }
  } else {
    // Tier 3: collaboration + structural tools
    registerCollaborationTools(registry);
    registerStructuralTools(registry);
  }

  const server = new McpServer({
    registry,
    serverName: "knowledge-store",
    serverVersion: "0.1.0",
  });

  return createMcpRouter({
    server,
    onWsEvent: options?.onWsEvent,
  });
}

const AI_UA_RE = /claude|cursor/i;

/**
 * Create an auto-detecting MCP router that picks tier based on User-Agent.
 *
 * "claude" or "cursor" (case-insensitive) in User-Agent → tier 3,
 * otherwise → tier 1.
 */
export function createAutoDetectMcpRouter(options?: {
  onWsEvent?: (event: WsServerEvent) => void;
}): express.Router {
  const tier1Router = createKnowledgeStoreMcpRouter({ tier: 1, onWsEvent: options?.onWsEvent });
  const tier3Router = createKnowledgeStoreMcpRouter({ tier: 3, onWsEvent: options?.onWsEvent });

  const router = express.Router();
  router.use((req, _res, next) => {
    const ua = req.get("user-agent") ?? "";
    if (AI_UA_RE.test(ua)) {
      tier3Router(req, _res, next);
    } else {
      tier1Router(req, _res, next);
    }
  });
  return router;
}
