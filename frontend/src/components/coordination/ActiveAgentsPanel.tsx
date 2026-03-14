import { useState } from "react";
import { ContentPanel } from "../ContentPanel";
import { SectionHeadingChip } from "../SectionHeadingChip";
import { StatusPill } from "../StatusPill";
import type { Proposal } from "../../types/shared.js";
import type { AgentReadingState } from "./HeatmapTab";

function agentColor(actorId: string): string {
  let hash = 0;
  for (let i = 0; i < actorId.length; i++) {
    hash = actorId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 60%, 50%)`;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

interface ActiveAgentsPanelProps {
  agentReadings: Map<string, AgentReadingState>;
  proposals: Proposal[];
}

export function ActiveAgentsPanel({ agentReadings, proposals }: ActiveAgentsPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;

  const activeAgents = Array.from(agentReadings.values())
    .filter((a) => a.lastSeenAt > fiveMinAgo)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  return (
    <ContentPanel>
      <ContentPanel.Header>
        <div>
          <ContentPanel.Title>Active Agents</ContentPanel.Title>
        </div>
      </ContentPanel.Header>
      <ContentPanel.Body className="p-0">
        {activeAgents.length === 0 ? (
          <div className="p-4 text-xs text-text-muted">No agent activity in the last 5 minutes</div>
        ) : (
          activeAgents.map((agent) => {
            const agentProposals = proposals.filter((p) => p.writer.id === agent.actor_id);
            const pendingCount = agentProposals.filter((p) => p.status === "pending").length;
            const expanded = expandedId === agent.actor_id;
            return (
              <div key={agent.actor_id}>
                <div
                  onClick={() => setExpandedId(expanded ? null : agent.actor_id)}
                  className="flex items-center gap-3 px-4 py-2.5 border-b border-[#f5f2ed] hover:bg-[#faf8f5] cursor-pointer text-xs"
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: agentColor(agent.actor_id),
                      flexShrink: 0,
                    }}
                  />
                  <span className="font-medium text-text-primary">{agent.actor_display_name}</span>
                  <span className="text-text-muted">reading {agent.sections.size} sections</span>
                  {pendingCount > 0 && (
                    <StatusPill variant="yellow" showDot>{pendingCount} pending</StatusPill>
                  )}
                  <span className="ml-auto text-text-muted">{relativeTime(agent.lastSeenAt)}</span>
                </div>
                {expanded && (
                  <div className="px-6 py-3 bg-[#faf8f5] border-b border-[#f5f2ed] text-xs">
                    <div className="mb-2">
                      <span className="font-semibold text-text-secondary">Recent reads</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {Array.from(agent.sections.values()).map((sec, i) => (
                          <SectionHeadingChip key={i}>
                            {`${sec.doc_path}: ${sec.heading_path.join(" > ")}`}
                          </SectionHeadingChip>
                        ))}
                      </div>
                    </div>
                    {agentProposals.length > 0 && (
                      <div>
                        <span className="font-semibold text-text-secondary">Proposals</span>
                        {agentProposals.map((p) => (
                          <div key={p.id} className="flex items-center gap-2 mt-1">
                            <StatusPill
                              variant={p.status === "pending" ? "yellow" : p.status === "committed" ? "green" : "red"}
                              showDot
                            >
                              {p.status}
                            </StatusPill>
                            <span className="text-text-muted italic">{p.intent}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </ContentPanel.Body>
    </ContentPanel>
  );
}
