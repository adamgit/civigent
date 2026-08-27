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
import { registerSectionHistoryTools } from "./tools/section-history.js";
import type { WsServerEvent } from "../types/shared.js";
import express from "express";

export type McpTier = 1 | 2 | 3;

/**
 * Create a fully configured MCP router ready to mount on an Express app.
 *
 * tier 1 → registerFilesystemTools (read, write, list, delete, move)
 * tier 2 → registerFilesystemTools + registerPlanChangesTool
 * tier 3 → registerCollaborationTools + registerStructuralTools + registerSectionHistoryTools
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
    registerSectionHistoryTools(registry);
  }

  const server = new McpServer({
    registry,
    tier,
    serverName: "knowledge-store",
    serverVersion: "0.1.0",
  });

  return createMcpRouter({
    server,
    onWsEvent: options?.onWsEvent,
  });
}

/**
 * User-Agents that must be served the filesystem-compatible Tier 1 surface.
 * None today — unmatched and unknown clients get Tier 3.
 */
const TIER1_UA_RE: RegExp | null = null;

/**
 * Create an auto-detecting MCP router that picks tier based on User-Agent.
 *
 * Default is tier 3. Only a User-Agent matching TIER1_UA_RE is served tier 1.
 */
export function createAutoDetectMcpRouter(options?: {
  onWsEvent?: (event: WsServerEvent) => void;
}): express.Router {
  const tier1Router = createKnowledgeStoreMcpRouter({ tier: 1, onWsEvent: options?.onWsEvent });
  const tier3Router = createKnowledgeStoreMcpRouter({ tier: 3, onWsEvent: options?.onWsEvent });

  const router = express.Router();
  router.use((req, _res, next) => {
    const ua = req.get("user-agent") ?? "";
    if (TIER1_UA_RE !== null && TIER1_UA_RE.test(ua)) {
      tier1Router(req, _res, next);
    } else {
      tier3Router(req, _res, next);
    }
  });
  return router;
}
