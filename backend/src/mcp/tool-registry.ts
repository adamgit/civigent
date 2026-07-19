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
import { ProposalLockConflictError } from "../domain/proposal-fsm-locks.js";

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
  /**
   * Draft proposal ids created through THIS session, oldest → newest. Session-
   * LOCAL memory only (never persisted onto proposals): it backs the implicit
   * draft conveniences — Tier 3 `replace` and Tier 1/2 auto-withdraw — so
   * parallel MCP conversations under one agent credential never withdraw each
   * other's drafts. Lost with the session (TTL / DELETE / restart); the
   * proposals themselves survive and stay reachable by explicit `proposal_id`
   * and writer-scoped listing. Manage via `mcp/session-drafts.ts`.
   */
  draftIds?: string[];
  /**
   * Every proposal id this session created, oldest → newest, regardless of the
   * proposal's current status (draft, committed, withdrawn). Backs the
   * session-local `my_proposals` focus list (task 858): ids are never removed
   * on publish/withdraw (status is read live from storage when listing), only
   * pruned when a proposal no longer resolves. Session-LOCAL memory only —
   * never persisted onto proposals; lost with the session (TTL / DELETE /
   * restart), after which `my_proposals` is empty while the proposals survive.
   * Manage via `mcp/session-drafts.ts`.
   */
  createdProposalIds?: string[];
}

// ─── Tool handler type ───────────────────────────────────

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<McpToolCallResult>;

// ─── Registry ────────────────────────────────────────────

interface RegisteredTool {
  /**
   * Stable identifier for this tool, independent of its wire `name`. This is the
   * single place the tool is addressed by code/docs; the wire `name` is free to
   * change without touching any `{{tool:key}}` reference. NOT emitted on the wire.
   */
  key: string;
  definition: McpToolDefinition;
  handler: ToolHandler;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  /**
   * Wire names that have been renamed/removed. A call to one of these returns a
   * migration message (not an unknown-tool error) so an agent holding a stale tool
   * list learns to refresh rather than seeing a hard failure.
   */
  private deprecatedNames = new Set<string>();

  /**
   * Register a tool with a stable `key`, its schema definition, and handler.
   * The `key` is required with no default: a wire-name rename must touch
   * `definition.name` and NOTHING else, so a key that silently followed `name`
   * would defeat the single-source-of-truth invariant.
   * Throws if the `key` is missing or if the `key` or wire `name` is already
   * registered.
   */
  register(key: string, definition: McpToolDefinition, handler: ToolHandler): void {
    if (!key) {
      throw new Error(`Tool "${definition.name}" registered without a stable key`);
    }
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }
    for (const existing of this.tools.values()) {
      if (existing.key === key) {
        throw new Error(`Tool key "${key}" is already registered`);
      }
    }
    this.tools.set(definition.name, { key, definition, handler });
  }

  /**
   * Mark one or more wire names as deprecated (renamed/removed). A `tools/call`
   * for a deprecated name is answered with a migration message rather than an
   * unknown-tool error. See `server.ts` `handleToolCall`.
   */
  deprecate(...names: string[]): void {
    for (const name of names) this.deprecatedNames.add(name);
  }

  /**
   * Whether the given wire name is a deprecated (renamed/removed) tool name.
   */
  isDeprecated(name: string): boolean {
    return this.deprecatedNames.has(name);
  }

  /**
   * Map of stable `key` → current wire `name` for every registered tool. Used by
   * `/api/setup` so the frontend can substitute `{{tool:key}}` tokens in the served
   * `skill.md` / `cursor-rule.md` templates at render time.
   */
  toolKeyCatalog(): Record<string, string> {
    const catalog: Record<string, string> = {};
    for (const tool of this.tools.values()) {
      catalog[tool.key] = tool.definition.name;
    }
    return catalog;
  }

  /**
   * List all registered tool definitions (for tools/list response). The stable
   * `key` is intentionally NOT included — it is not part of the wire contract.
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
      // A commit-boundary FSM lock conflict (spec 12) is an expected agent-facing
      // CONFLICT, not a fault: surface the top-level prose `message` and the full
      // structured `lock_conflicts[]` (each with its own prose) via the Area M
      // blocked shaper — never a bare code, never just a stack.
      if (error instanceof ProposalLockConflictError) {
        return jsonBlockedToolResult(error.result.message, { lock_conflicts: error.result.conflicts });
      }
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

/**
 * Area M — shared shaper for blocked/deferred MCP tool results.
 *
 * Enforces the response contract for every agent-facing blocked outcome:
 *   - a REQUIRED top-level prose `message` (verbose + action-oriented),
 *   - `outcome: "blocked"` as a machine branch flag ONLY (never the explanation),
 *   - optional structured detail bodies (e.g. `agent_write_policy`,
 *     `lock_conflicts`) whose own prose `message`s explain each target.
 *
 * Callers must pass already-authored prose (sourced from the domain
 * `AgentWritePolicyResult.message` / `ProposalLockConflict.message`); this helper
 * never derives text from a code/enum/threshold and forbids bare reason-code
 * fields (`block_reason`, `blocked_reason`) in the merged detail body.
 */
export function jsonBlockedToolResult(
  message: string,
  detail: Record<string, unknown>,
): McpToolCallResult {
  return jsonToolResult({
    outcome: "blocked",
    message,
    ...detail,
  });
}
