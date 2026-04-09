import { useCallback, useEffect, useRef, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ActivityTabStrip } from "../components/ActivityTabStrip";
import { PageStatusBar } from "../components/PageStatusBar";
import { HeatmapTab, type AgentReadingState } from "../components/coordination/HeatmapTab";
import { AgentActivityTab } from "../components/coordination/AgentActivityTab";
import { GitHistoryTab } from "../components/coordination/GitHistoryTab";
import type { ProposalTimelineEntry } from "../components/coordination/ProposalTimeline";
import { apiClient } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import { sectionGlobalKey, type GetHeatmapResponse, type AnyProposal, type WsServerEvent } from "../types/shared.js";
import { diffProposalsForTimeline } from "../services/proposal-timeline-diff";

const TABS = [
  { label: "Heatmap", key: "heatmap" },
  { label: "Agent Activity", key: "agents" },
  { label: "Git History", key: "git" },
];

export function CoordinationPage() {
  const [activeTab, setActiveTab] = useState("heatmap");
  const [heatmap, setHeatmap] = useState<GetHeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<AnyProposal[]>([]);
  const [agentReadings, setAgentReadings] = useState<Map<string, AgentReadingState>>(new Map());
  const [proposalTimeline, setProposalTimeline] = useState<ProposalTimelineEntry[]>([]);
  const prevProposalMapRef = useRef<Map<string, { status: string }>>(new Map());
  const timelineIdRef = useRef(0);
  const wsRef = useRef<KnowledgeStoreWsClient | null>(null);

  const loadHeatmap = useCallback(async () => {
    try {
      const result = await apiClient.getHeatmap();
      setHeatmap(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

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

  // Poll heatmap + proposals every 10s
  useEffect(() => {
    void loadHeatmap();
    void loadProposals();
    const interval = setInterval(() => {
      void loadHeatmap();
      void loadProposals();
    }, 10000);
    return () => clearInterval(interval);
  }, [loadHeatmap, loadProposals]);

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
          for (const hp of event.heading_paths) {
            const key = sectionGlobalKey(event.doc_path, hp);
            existing.sections.set(key, {
              doc_path: event.doc_path,
              heading_path: hp,
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
      // Refresh heatmap on relevant events
      if (event.type === "content:committed" || event.type === "presence:editing" || event.type === "presence:done") {
        void loadHeatmap();
      }
    });
    return () => {
      ws.disconnect();
      wsRef.current = null;
    };
  }, [loadHeatmap]);

  const activeAgentCount = Array.from(agentReadings.values()).filter(
    (a) => Date.now() - a.lastSeenAt < 5 * 60 * 1000,
  ).length;

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Coordination" backTo="/" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        <ActivityTabStrip tabs={TABS} activeKey={activeTab} onTabChange={setActiveTab} />

        {activeTab === "heatmap" && (
          <HeatmapTab
            heatmap={heatmap}
            agentReadings={agentReadings}
            proposals={proposals}
            loading={loading}
            error={error}
          />
        )}
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
          `Preset: ${heatmap?.preset ?? "loading"}`,
          `${heatmap?.sections.length ?? 0} sections tracked`,
          `${activeAgentCount} active agents`,
        ]}
      />
    </div>
  );
}
