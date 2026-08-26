import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { AgentCard } from "../components/agents/AgentCard.js";
import { AgentCardExpanded } from "../components/agents/AgentCardExpanded.js";
import type { AgentCardViewModel } from "../components/agents/types.js";
import { avatarHueFromId } from "../components/agents/utils.js";
import { apiClient } from "../services/api-client";
import type { AgentAuthPolicy, GetAgentsFullSummaryResponse } from "../types/shared.js";
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
      pendingProposals: agent.draft_proposals,
      recentProposals: agent.recent_proposals,
      stats: agent.stats,
    };
  });
}

// ─── Policy badge ───────────────────────────────────────────────

const POLICY_BADGE: Record<AgentAuthPolicy, { label: string; color: string; bg: string; title: string }> = {
  open:         { label: "open",         color: "#7f1d1d", bg: "#fee2e2", title: "Any agent can self-register. Anonymous identities are allowed." },
  approve:      { label: "approve",      color: "#92400e", bg: "#fef3c7", title: "Agents self-register, but a signed-in human must approve each agent's first connection in the browser." },
  confidential: { label: "confidential", color: "#166534", bg: "#dcfce7", title: "Admin-registered agents only. The agent must present its client_secret at the token endpoint." },
};

function PolicyBadge({ policy }: { policy: AgentAuthPolicy }) {
  const { label, color, bg, title } = POLICY_BADGE[policy];
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "0.15rem 0.55rem",
        borderRadius: "999px",
        fontSize: "0.75rem",
        fontWeight: 600,
        color,
        background: bg,
        verticalAlign: "middle",
        cursor: "default",
        letterSpacing: "0.02em",
      }}
    >
      {label}
    </span>
  );
}

// ─── Page ───────────────────────────────────────────────────────

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
      .catch((err) => { setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { setLoading(false); });
  }, []);

  const viewModels = data ? buildViewModels(data) : [];
  const policy: AgentAuthPolicy = data?.agent_auth_policy ?? "open";

  return (
    <section className="min-h-0 flex-1 overflow-auto">
      <SharedPageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            <span>Agents</span>
            {data ? (
              <>
                <span className="text-xs font-medium text-text-muted">Agent auth policy:</span>
                <PolicyBadge policy={policy} />
              </>
            ) : null}
          </span>
        }
      />

      {loading ? (
        <p className="px-4 text-sm text-gray-500">Loading agents...</p>
      ) : null}

      {error ? (
        <p className="px-4 text-sm text-error">{error}</p>
      ) : null}

      {!loading && !error ? (
        <div className="agents-grid">
          {viewModels.flatMap((vm) => {
            const items = [
              <AgentCard
                key={vm.id}
                vm={vm}
                onClick={() => setExpandedId(expandedId === vm.id ? null : vm.id)}
              />,
            ];
            if (expandedId === vm.id) {
              items.push(
                <div key={`${vm.id}-expanded`} className="agents-card-expanded-row">
                  <AgentCardExpanded vm={vm} />
                </div>,
              );
            }
            return items;
          })}
          <Link
            to="/setup"
            className="agents-card agents-card--add-new"
          >
            <span className="agents-card__add-icon">+</span>
            <span className="agents-card__add-label">Add agent</span>
          </Link>
        </div>
      ) : null}
    </section>
  );
}
