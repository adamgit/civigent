import { useCallback, useEffect, useRef, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ActivityTabStrip } from "../components/ActivityTabStrip";
import { PageStatusBar } from "../components/PageStatusBar";
import type { AgentReadingState } from "../components/coordination/agent-reading-state";
import { AgentActivityTab } from "../components/coordination/AgentActivityTab";
import { GitHistoryTab } from "../components/coordination/GitHistoryTab";
import type { ProposalTimelineEntry } from "../components/coordination/ProposalTimeline";
import { apiClient } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import { sectionGlobalKey, type AnyProposal, type WsServerEvent } from "../types/shared.js";
import { diffProposalsForTimeline } from "../services/proposal-timeline-diff";

const TABS = [
  { label: "Agent Activity", key: "agents" },
  { label: "Git History", key: "git" },
];

export function CoordinationPage() {
  const [activeTab, setActiveTab] = useState("agents");
  const [proposals, setProposals] = useState<AnyProposal[]>([]);
  const [agentReadings, setAgentReadings] = useState<Map<string, AgentReadingState>>(new Map());
  const [proposalTimeline, setProposalTimeline] = useState<ProposalTimelineEntry[]>([]);
  const prevProposalMapRef = useRef<Map<string, { status: string }>>(new Map());
  const timelineIdRef = useRef(0);
  const wsRef = useRef<KnowledgeStoreWsClient | null>(null);

  const loadProposals = useCallback(async () => {
    try {
      const result = await apiClient.listProposals();
      const proposalList = result.proposals ?? [];
      setProposals(proposalList);

      const { entries, nextMap, nextIdSeed } = diffProposalsForTimeline(
        prevProposalMapRef.current,
        proposalList,
        Date.now(),
        timelineIdRef.current,
      );
      timelineIdRef.current = nextIdSeed;
      prevProposalMapRef.current = nextMap;
      if (entries.length > 0) {
        setProposalTimeline((prev) => [...entries, ...prev].slice(0, 200));
      }
    } catch {
      // non-fatal poll
    }
  }, []);

  useEffect(() => {
    void loadProposals();
  }, [loadProposals]);

  // WebSocket for live events
  useEffect(() => {
    const ws = new KnowledgeStoreWsClient();
    wsRef.current = ws;
    ws.connect();
    ws.onEvent((event: WsServerEvent) => {
      if (event.type === "agent:reading") {
        setAgentReadings((prev) => {
          const next = new Map(prev);
          const existing = next.get(event.actor_id) ?? {
            actor_id: event.actor_id,
            actor_display_name: event.actor_display_name,
            sections: new Map(),
            lastSeenAt: 0,
          };
          existing.lastSeenAt = Date.now();
          if (event.kind === "section_read") {
            const key = sectionGlobalKey(event.doc_path, event.heading_path);
            existing.sections.set(key, {
              doc_path: event.doc_path,
              heading_path: event.heading_path,
              lastSeenAt: Date.now(),
            });
          }
          next.set(event.actor_id, existing);
          // Prune old agents
          const fiveMinAgo = Date.now() - 5 * 60 * 1000;
          for (const [id, agent] of next) {
            if (agent.lastSeenAt < fiveMinAgo) next.delete(id);
          }
          return next;
        });
      }
    });
    return () => {
      ws.disconnect();
      wsRef.current = null;
    };
  }, []);

  const activeAgentCount = Array.from(agentReadings.values()).filter(
    (a) => Date.now() - a.lastSeenAt < 5 * 60 * 1000,
  ).length;

  return (
    <div className="flex flex-col">
      <SharedPageHeader title="Coordination" backTo="/" />
      <div className="p-4" style={{ fontFamily: "var(--font-ui)" }}>
        <ActivityTabStrip tabs={TABS} activeKey={activeTab} onTabChange={setActiveTab} />

        {activeTab === "agents" && (
          <AgentActivityTab
            agentReadings={agentReadings}
            proposals={proposals}
            proposalTimeline={proposalTimeline}
          />
        )}
        {activeTab === "git" && <GitHistoryTab />}
      </div>
      <PageStatusBar
        items={[
          "Coordination",
          `${activeAgentCount} active agents`,
        ]}
      />
    </div>
  );
}
