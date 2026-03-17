import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ActivityFeed } from "../components/agents/ActivityFeed.js";
import type { ActivityFeedEvent } from "../components/agents/types.js";
import { avatarHueFromId } from "../components/agents/utils.js";
import { apiClient } from "../services/api-client";
import type { GetAgentsFullSummaryResponse } from "../types/shared.js";

function buildFeedEvents(response: GetAgentsFullSummaryResponse): ActivityFeedEvent[] {
  const events: ActivityFeedEvent[] = [];
  for (const agent of response.agents) {
    const hue = avatarHueFromId(agent.agent_id);
    const letter = (agent.display_name.trim()[0] ?? "?").toUpperCase();
    for (const proposal of [...agent.pending_proposals, ...agent.recent_proposals]) {
      events.push({
        id: `${agent.agent_id}-${proposal.id}`,
        agentId: agent.agent_id,
        agentDisplayName: agent.display_name,
        agentAvatarLetter: letter,
        agentAvatarHue: hue,
        action: proposal.status === "committed" ? "committed" : proposal.status === "withdrawn" ? "withdrew" : "submitted",
        targetDescription: proposal.intent,
        timestamp: proposal.created_at,
        documentPreview: proposal.doc_paths.join(", ") || undefined,
      });
    }
  }
  // Sort newest first
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return events;
}

export function AgentFeedPage() {
  const [events, setEvents] = useState<ActivityFeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiClient.getAgentsSummary()
      .then((res: GetAgentsFullSummaryResponse) => {
        setEvents(buildFeedEvents(res));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <section>
      <SharedPageHeader title="Agent Activity Feed" backTo="/agents" />

      <div className="px-4 py-2 border-b border-gray-100">
        <Link to="/agents" className="text-xs text-blue-600 hover:underline">
          &larr; Back to Agents
        </Link>
      </div>

      {loading ? (
        <p className="px-4 py-3 text-sm text-gray-500">Loading activity feed...</p>
      ) : null}

      {error ? (
        <p className="px-4 py-3 text-sm text-red-600">{error}</p>
      ) : null}

      {!loading && !error ? (
        <ActivityFeed events={events} />
      ) : null}
    </section>
  );
}
