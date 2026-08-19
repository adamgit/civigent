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
  /** Tail of the in-flight flush chain per compound key (serializes flushes). */
  private flushTails = new Map<string, Promise<void>>();

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
   * memory. No-op if the session has no recorded actions. The buffer is taken
   * from the map before the write awaits, so a `record()` racing an in-flight
   * flush lands in a fresh buffer (picked up by the next flush) instead of being
   * wiped; flushes for one compound key are serialized so overlapping calls
   * cannot write duplicate envelopes. NEVER touches proposals — dropping this
   * buffer is monitoring cleanup, not lifecycle.
   */
  async flushSessionActivityBestEffort(sessionId: string, agentId: string): Promise<void> {
    const key = compoundActivityKey(agentId, sessionId);
    // Serialize per compound key: an overlapping flush waits for the in-flight
    // one instead of snapshotting the same buffer (duplicate JSONL envelopes).
    const prev = this.flushTails.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.flushBuffer(key, sessionId));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.flushTails.set(key, tail);
    void tail.then(() => {
      if (this.flushTails.get(key) === tail) this.flushTails.delete(key);
    });
    return tail;
  }

  private async flushBuffer(key: string, sessionId: string): Promise<void> {
    // TAKE the buffer synchronously, before any await yields: a concurrent
    // record() then starts a fresh buffer instead of appending into a snapshot
    // that would be discarded when this flush completes.
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (!session || session.actions.length === 0) return;

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
    // A failed append DROPS the taken actions by design: this buffer is
    // monitoring-only, never durable application state, so it is not restored
    // or retried. Actions recorded while this flush was in flight stay in the
    // fresh buffer and flush later.
    await mkdir(getMonitoringRoot(), { recursive: true });
    await appendFile(getActivityLogPath(), line, "utf-8");
  }

  /**
   * Check if a `(agentId, sessionId)` session has any recorded actions.
   */
  has(sessionId: string, agentId: string): boolean {
    return this.sessions.has(compoundActivityKey(agentId, sessionId));
  }

  /**
   * Copy in-flight session buffers as SessionRecord envelopes (ended_at = now).
   * Does not flush or mutate — home/pulse reads live MCP calls that have not
   * hit JSONL yet because the MCP session is still open.
   */
  snapshotInFlight(): SessionRecord[] {
    const endedAt = new Date().toISOString();
    const records: SessionRecord[] = [];
    for (const [key, session] of this.sessions) {
      const nul = key.indexOf("\u0000");
      const sessionId = nul === -1 ? "" : key.slice(nul + 1);
      records.push({
        session_id: sessionId,
        agent_id: session.agentId,
        agent_display_name: session.agentDisplayName,
        started_at: new Date(session.startedAt).toISOString(),
        ended_at: endedAt,
        action_count: session.actions.length,
        actions: session.actions.map((action) => ({
          method: action.method,
          ts: action.ts,
          metadata: { ...action.metadata },
        })),
      });
    }
    return records;
  }
}

// Singleton instance
export const activityLog = new ActivityLog();
