/**
 * Agent Event Log — in-memory append-only event log for agent activity tracking.
 *
 * Tracks tool calls, proposal lifecycle events per agent. Provides status
 * heuristics (active/idle/offline), tool usage counts, and proposal stats.
 *
 * Singleton instance exported for use by MCP tool dispatch and proposal lifecycle.
 */

import type { WriterIdentity, AgentConnectionStatus, AgentRosterEntry } from "../types/shared.js";

// ─── Event types ─────────────────────────────────────────────────

interface ToolCallEvent {
  kind: "tool_call";
  tool: string;
}

interface ProposalCreatedEvent {
  kind: "proposal_created";
  proposalId: string;
}

interface ProposalCommittedEvent {
  kind: "proposal_committed";
  proposalId: string;
}

interface ProposalBlockedEvent {
  kind: "proposal_blocked";
  proposalId: string;
}

interface ProposalWithdrawnEvent {
  kind: "proposal_withdrawn";
  proposalId: string;
}

export type AgentEvent =
  | ToolCallEvent
  | ProposalCreatedEvent
  | ProposalCommittedEvent
  | ProposalBlockedEvent
  | ProposalWithdrawnEvent;

interface TimestampedEvent {
  event: AgentEvent;
  ts: number;
}

interface AgentLog {
  agentId: string;
  displayName: string;
  events: TimestampedEvent[];
}

// ─── Heuristic thresholds ────────────────────────────────────────

const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;   // 5 minutes
const IDLE_THRESHOLD_MS = 30 * 60 * 1000;     // 30 minutes

// ─── AgentEventLog class ─────────────────────────────────────────

export class AgentEventLog {
  private logs = new Map<string, AgentLog>();

  append(writer: WriterIdentity, event: AgentEvent): void {
    let log = this.logs.get(writer.id);
    if (!log) {
      log = { agentId: writer.id, displayName: writer.displayName, events: [] };
      this.logs.set(writer.id, log);
    }
    log.displayName = writer.displayName;
    log.events.push({ event, ts: Date.now() });
  }

  getStatus(agentId: string): AgentConnectionStatus {
    const log = this.logs.get(agentId);
    if (!log || log.events.length === 0) return "offline";

    const lastTs = log.events[log.events.length - 1].ts;
    const elapsed = Date.now() - lastTs;

    if (elapsed < ACTIVE_THRESHOLD_MS) return "active";
    if (elapsed < IDLE_THRESHOLD_MS) return "idle";
    return "offline";
  }

  lastSeenAt(agentId: string): string | null {
    const log = this.logs.get(agentId);
    if (!log || log.events.length === 0) return null;
    return new Date(log.events[log.events.length - 1].ts).toISOString();
  }

  toolUsageCounts(agentId: string): Record<string, number> {
    const log = this.logs.get(agentId);
    if (!log) return {};

    const counts: Record<string, number> = {};
    for (const { event } of log.events) {
      if (event.kind === "tool_call") {
        counts[event.tool] = (counts[event.tool] ?? 0) + 1;
      }
    }
    return counts;
  }

  proposalStats(agentId: string): {
    proposals_committed: number;
    proposals_blocked: number;
    proposals_withdrawn: number;
    total_tool_calls: number;
  } {
    const log = this.logs.get(agentId);
    if (!log) return { proposals_committed: 0, proposals_blocked: 0, proposals_withdrawn: 0, total_tool_calls: 0 };

    let committed = 0, blocked = 0, withdrawn = 0, toolCalls = 0;
    for (const { event } of log.events) {
      switch (event.kind) {
        case "proposal_committed": committed++; break;
        case "proposal_blocked": blocked++; break;
        case "proposal_withdrawn": withdrawn++; break;
        case "tool_call": toolCalls++; break;
      }
    }
    return { proposals_committed: committed, proposals_blocked: blocked, proposals_withdrawn: withdrawn, total_tool_calls: toolCalls };
  }

  /**
   * List roster entries for all known agents. Merges registered agents
   * with transient agents seen in the log. Presence, process-lifetime
   * stats, and tool usage only — no proposal data.
   */
  listRosterEntries(
    registeredAgents: Array<{ id: string; displayName: string }>,
  ): AgentRosterEntry[] {
    // Merge registered + transient agents from log
    const agentMap = new Map<string, { id: string; displayName: string }>();
    for (const agent of registeredAgents) {
      agentMap.set(agent.id, agent);
    }
    for (const [agentId, log] of this.logs) {
      if (!agentMap.has(agentId)) {
        agentMap.set(agentId, { id: agentId, displayName: log.displayName });
      }
    }

    const entries: AgentRosterEntry[] = [];

    for (const { id, displayName } of agentMap.values()) {
      entries.push({
        agent_id: id,
        display_name: displayName,
        connection_status: this.getStatus(id),
        last_seen_at: this.lastSeenAt(id),
        mcp_tool_usage: this.toolUsageCounts(id),
        stats: this.proposalStats(id),
      });
    }

    return entries;
  }
}

// Singleton instance
export const agentEventLog = new AgentEventLog();
