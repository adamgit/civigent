/**
 * ActivityLog — persistent JSONL-backed activity log for agent MCP sessions.
 *
 * record() accumulates events in memory keyed by MCP session ID.
 * flush() serializes the full session record as one JSON line, appends to
 * the monitoring JSONL file, and deletes the session from memory.
 *
 * Schema:
 *   Each JSONL line is a SessionRecord envelope containing an array of actions.
 *   The envelope includes agent identity, session timing, and aggregate stats.
 */

import { appendFile } from "node:fs/promises";
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

export class ActivityLog {
  private sessions = new Map<string, InFlightSession>();

  /**
   * Record an action for the given MCP session.
   * Creates the in-flight session entry on first call.
   */
  record(
    sessionId: string,
    agentId: string,
    agentDisplayName: string,
    method: string,
    metadata: Record<string, unknown>,
  ): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        agentId,
        agentDisplayName,
        startedAt: Date.now(),
        actions: [],
      };
      this.sessions.set(sessionId, session);
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
   * Flush a session to the JSONL file and remove from memory.
   * No-op if the session has no recorded actions.
   */
  async flush(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.actions.length === 0) {
      this.sessions.delete(sessionId);
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

    await appendFile(getActivityLogPath(), line, "utf-8");

    this.sessions.delete(sessionId);
  }

  /**
   * Check if a session has any recorded actions.
   */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}

// Singleton instance
export const activityLog = new ActivityLog();
