/**
 * ActivityLog — persistent JSONL-backed activity log for agent MCP sessions.
 *
 * record() accumulates events in memory keyed by the COMPOUND
 * `(agentId, sessionId)` (Option A session isolation): a session-id string reused
 * across two writers must never share one in-flight activity buffer. flush()
 * serializes the full session record as one JSON line, appends to the monitoring
 * JSONL file, and deletes that compound entry from memory. flush/has never mutate
 * proposals — this is a monitoring buffer only.
 *
 * Schema:
 *   Each JSONL line is a SessionRecord envelope containing an array of actions.
 *   The envelope includes agent identity, session timing, and aggregate stats.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getMonitoringRoot } from "../storage/data-root.js";

// ─── Types ────────────────────────────────────────────────

export interface ActionEntry {
  method: string;
  ts: string; // ISO 8601
  metadata: Record<string, unknown>;
}

export interface SessionRecord {
  session_id: string;
  agent_id: string;
  agent_display_name: string;
  started_at: string; // ISO 8601 — first record() call
  ended_at: string;   // ISO 8601 — flush() call
  action_count: number;
  actions: ActionEntry[];
}

interface InFlightSession {
  agentId: string;
  agentDisplayName: string;
  startedAt: number;
  actions: ActionEntry[];
}

// ─── Paths ────────────────────────────────────────────────

function getActivityLogPath(): string {
  return path.join(getMonitoringRoot(), "agent-mcp-activity.jsonl");
}

// ─── ActivityLog class ────────────────────────────────────

/**
 * Compound in-memory key: `(agentId, sessionId)`. A writer id can never contain a
 * NUL byte, so the join is unambiguous. Two writers that present the same session
 * id string get distinct buffers; one writer keeps its buffer across memory misses
 * as long as it reuses its session id.
 */
function compoundActivityKey(agentId: string, sessionId: string): string {
  return `${agentId}\u0000${sessionId}`;
}

export class ActivityLog {
  private sessions = new Map<string, InFlightSession>();

  /**
   * Record an action for the given `(agentId, sessionId)` MCP session.
   * Creates the in-flight session entry on first call.
   */
  record(
    sessionId: string,
    agentId: string,
    agentDisplayName: string,
    method: string,
    metadata: Record<string, unknown>,
  ): void {
    const key = compoundActivityKey(agentId, sessionId);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        agentId,
        agentDisplayName,
        startedAt: Date.now(),
        actions: [],
      };
      this.sessions.set(key, session);
    }
    // Update display name in case it changed
    session.agentDisplayName = agentDisplayName;

    session.actions.push({
      method,
      ts: new Date().toISOString(),
      metadata,
    });
  }

  /**
   * Flush the `(agentId, sessionId)` session to the JSONL file and remove it from
   * memory. No-op (memory only) if the session has no recorded actions. NEVER
   * touches proposals — dropping this buffer is monitoring cleanup, not lifecycle.
   */
  async flush(sessionId: string, agentId: string): Promise<void> {
    const key = compoundActivityKey(agentId, sessionId);
    const session = this.sessions.get(key);
    if (!session || session.actions.length === 0) {
      this.sessions.delete(key);
      return;
    }

    const record: SessionRecord = {
      session_id: sessionId,
      agent_id: session.agentId,
      agent_display_name: session.agentDisplayName,
      started_at: new Date(session.startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      action_count: session.actions.length,
      actions: session.actions,
    };

    const line = JSON.stringify(record) + "\n";

    // The monitoring dir may not exist yet on a fresh data root; a missing dir
    // must not reject the flush (the DELETE-session route awaits it).
    await mkdir(getMonitoringRoot(), { recursive: true });
    await appendFile(getActivityLogPath(), line, "utf-8");

    this.sessions.delete(key);
  }

  /**
   * Check if a `(agentId, sessionId)` session has any recorded actions.
   */
  has(sessionId: string, agentId: string): boolean {
    return this.sessions.has(compoundActivityKey(agentId, sessionId));
  }
}

// Singleton instance
export const activityLog = new ActivityLog();
