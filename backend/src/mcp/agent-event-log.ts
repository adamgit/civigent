/**
 * Agent Event Log — in-memory append-only event log for agent activity tracking.
 *
 * Tracks tool calls, proposal lifecycle events per agent. Provides status
 * heuristics (active/idle/offline), tool usage counts, and proposal stats.
 *
 * Singleton instance exported for use by MCP tool dispatch and proposal lifecycle.
 */

import type { WriterIdentity, AgentConnectionStatus, AgentActivitySummary, AgentProposalSnapshot, AnyProposal, ProposalStatus } from "../types/shared.js";

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
   * Build full summary for all known agents. Merges registered agents
   * with transient agents seen in the log.
   */
  buildFullSummary(
    registeredAgents: Array<{ id: string; displayName: string }>,
    allProposals: AnyProposal[],
  ): AgentActivitySummary[] {
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

    const summaries: AgentActivitySummary[] = [];

    for (const { id, displayName } of agentMap.values()) {
      const status = this.getStatus(id);
      const lastSeen = this.lastSeenAt(id);
      const toolUsage = this.toolUsageCounts(id);
      const stats = this.proposalStats(id);

      // Filter proposals by this agent
      const agentProposals = allProposals.filter(p => p.writer.id === id);

      const pending: AgentProposalSnapshot[] = agentProposals
        .filter(p => p.status === "pending")
        .map(p => ({
          id: p.id,
          intent: p.intent,
          status: p.status,
          created_at: p.created_at,
          doc_paths: [...new Set(p.sections.map(s => s.doc_path))],
          section_count: p.sections.length,
        }));

      const recent: AgentProposalSnapshot[] = agentProposals
        .filter(p => p.status === "committed" || p.status === "withdrawn")
        .slice(0, 10)
        .map(p => ({
          id: p.id,
          intent: p.intent,
          status: p.status,
          created_at: p.created_at,
          doc_paths: [...new Set(p.sections.map(s => s.doc_path))],
          section_count: p.sections.length,
        }));

      summaries.push({
        agent_id: id,
        display_name: displayName,
        connection_status: status,
        last_seen_at: lastSeen,
        mcp_tool_usage: toolUsage,
        pending_proposals: pending,
        recent_proposals: recent,
        stats,
      });
    }

    return summaries;
  }
}

// Singleton instance
export const agentEventLog = new AgentEventLog();
