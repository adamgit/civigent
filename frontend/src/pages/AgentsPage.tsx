import { useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { SystemPostureBar } from "../components/agents/SystemPostureBar.js";
import { McpToolLegend } from "../components/agents/McpToolLegend.js";
import { AgentCard } from "../components/agents/AgentCard.js";
import type { AgentCardViewModel } from "../components/agents/types.js";
import { avatarHueFromId } from "../components/agents/utils.js";
import { apiClient } from "../services/api-client";
import type { GetAgentsFullSummaryResponse } from "../types/shared.js";
import "./agents-page.css";

function buildViewModels(response: GetAgentsFullSummaryResponse): AgentCardViewModel[] {
  return response.agents.map((agent) => {
    const hue = avatarHueFromId(agent.agent_id);
    const letter = (agent.display_name.trim()[0] ?? "?").toUpperCase();
    return {
      id: agent.agent_id,
      displayName: agent.display_name,
      avatarLetter: letter,
      avatarHue: hue,
      connectionStatus: agent.connection_status,
      lastSeenAt: agent.last_seen_at,
      currentActivityHtml: "",
      activeDocuments: [],
      mcpToolUsage: agent.mcp_tool_usage,
      pendingProposals: agent.pending_proposals,
      recentProposals: agent.recent_proposals,
      stats: agent.stats,
    };
  });
}

export function AgentsPage() {
  const [data, setData] = useState<GetAgentsFullSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiClient.getAgentsSummary()
      .then((res) => {
        setData(res);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const viewModels = data ? buildViewModels(data) : [];

  return (
    <section>
      <SharedPageHeader title="Agents" />

      <div className="px-4 py-3 flex flex-col gap-3">
        {data ? (
          <SystemPostureBar
            preset={data.posture.preset}
            summary={data.posture.description}
          />
        ) : null}

        <McpToolLegend />
      </div>

      {loading ? (
        <p className="px-4 text-sm text-gray-500">Loading agents...</p>
      ) : null}

      {error ? (
        <p className="px-4 text-sm text-red-600">{error}</p>
      ) : null}

      {!loading && !error && viewModels.length === 0 ? (
        <p className="px-4 text-sm text-gray-500">No agents connected yet.</p>
      ) : null}

      {!loading && !error && viewModels.length > 0 ? (
        <div className="agents-grid">
          {viewModels.map((vm) => (
            <AgentCard
              key={vm.id}
              vm={vm}
              onClick={() => setExpandedId(expandedId === vm.id ? null : vm.id)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
