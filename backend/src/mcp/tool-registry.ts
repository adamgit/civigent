/**
 * MCP tool registry — defines, stores, and dispatches tool calls.
 *
 * Tools are registered with a name, JSON Schema input definition,
 * and an async handler. The registry is used by the MCP server to
 * list available tools and dispatch calls.
 */

import type { McpToolDefinition, McpToolCallResult } from "./protocol.js";
import { makeToolResult, makeToolErrorResult } from "./protocol.js";
import type { AuthenticatedWriter } from "../auth/context.js";
import type { WsServerEvent } from "../types/shared.js";

// ─── Tool handler context ────────────────────────────────

/**
 * Context passed to every tool handler. Provides access to
 * the authenticated writer, the per-session plan_changes state,
 * and a callback to emit WebSocket events.
 */
export interface ToolContext {
  /** The authenticated agent/human calling this tool */
  writer: AuthenticatedWriter;
  /** Emit a server event (broadcasts through WS hub) */
  emitEvent?: (event: WsServerEvent) => void;
  /** Per-session mutable state for Tier 2 plan_changes */
  session: McpSession;
}

/**
 * Per-connection session state. Mutable — tools can read/write this.
 * Currently holds the Tier 2 "pending intent" set by plan_changes.
 */
export interface McpSession {
  /** MCP session ID (set by transport layer, used for activity logging) */
  sessionId?: string;
  /** Intent label set by plan_changes, consumed by next write */
  pendingIntent?: string;
}

// ─── Tool handler type ───────────────────────────────────

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<McpToolCallResult>;

// ─── Registry ────────────────────────────────────────────

interface RegisteredTool {
  definition: McpToolDefinition;
  handler: ToolHandler;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  /**
   * Register a tool with its schema definition and handler.
   * Throws if a tool with the same name is already registered.
   */
  register(definition: McpToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }
    this.tools.set(definition.name, { definition, handler });
  }

  /**
   * List all registered tool definitions (for tools/list response).
   */
  listTools(): McpToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  /**
   * Check if a tool exists.
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Call a tool by name with the given arguments and context.
   * Returns a tool result (success or error).
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<McpToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return makeToolErrorResult(`Unknown tool: ${name}`);
    }

    try {
      const result = await tool.handler(args, ctx);
      if (ctx.writer.type === "agent") {
        const { agentEventLog } = await import("./agent-event-log.js");
        agentEventLog.append(ctx.writer, { kind: "tool_call", tool: name });

        // Persistent activity log — append per-call metadata for JSONL persistence
        if (ctx.session.sessionId) {
          const { activityLog } = await import("../monitoring/activity-log.js");
          const metadata: Record<string, unknown> = {};
          if (typeof args.doc_path === "string") metadata.doc_path = args.doc_path;
          if (Array.isArray(args.heading_path)) metadata.heading_path = args.heading_path;
          if (Array.isArray(args.sections)) metadata.sections_count = args.sections.length;
          if (typeof args.content === "string") metadata.content_chars = args.content.length;
          activityLog.record(
            ctx.session.sessionId,
            ctx.writer.id,
            ctx.writer.displayName,
            name,
            metadata,
          );
        }
      }
      return result;
    } catch (error) {
      // Per CLAUDE.md: never hide errors — expose full stack trace
      const message = error instanceof Error
        ? error.stack ?? error.message
        : String(error);
      return makeToolErrorResult(message);
    }
  }
}

/**
 * Helper to create a tool result with JSON-serialized data.
 */
export function jsonToolResult(data: unknown): McpToolCallResult {
  return makeToolResult(JSON.stringify(data, null, 2));
}

/**
 * Helper to create a simple success text result.
 */
export function textToolResult(text: string): McpToolCallResult {
  return makeToolResult(text);
}
