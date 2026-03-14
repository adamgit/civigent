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
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerCollaborationTools } from "./tools/collaboration.js";
import { registerStructuralTools } from "./tools/structural.js";
import type { WsServerEvent } from "../types/shared.js";
import type express from "express";

/**
 * Create a fully configured MCP router ready to mount on an Express app.
 *
 * Usage:
 *   app.use("/mcp", createKnowledgeStoreMcpRouter({ onWsEvent }));
 */
export function createKnowledgeStoreMcpRouter(options?: {
  onWsEvent?: (event: WsServerEvent) => void;
}): express.Router {
  const registry = new ToolRegistry();

  // Tier 1 + 2: filesystem-compatible tools
  registerFilesystemTools(registry);

  // Tier 3: collaboration tools with explicit proposals
  registerCollaborationTools(registry);

  // Tier 3: structural tools (create/delete/move/rename sections, delete doc)
  registerStructuralTools(registry);

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
