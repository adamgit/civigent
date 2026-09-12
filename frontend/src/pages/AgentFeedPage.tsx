import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ActivityFeed } from "../components/agents/ActivityFeed.js";
import type { ActivityFeedEvent } from "../components/agents/types.js";
import { avatarHueFromId } from "../components/agents/utils.js";
import { apiClient } from "../services/api-client";
import { HOME_ACTIVITY_FETCH_DAYS, HOME_ACTIVITY_FETCH_LIMIT } from "./home/home-constants";
import {
  proposalSectionDocPathForDisplay,
  type ActivityItem,
  type AnyProposal,
  type GetAgentRosterResponse,
} from "../types/shared.js";

function buildFeedEvents(
  roster: GetAgentRosterResponse,
  liveProposals: readonly AnyProposal[],
  activity: readonly ActivityItem[],
): ActivityFeedEvent[] {
  const events: ActivityFeedEvent[] = [];
  for (const agent of roster.agents) {
    const hue = avatarHueFromId(agent.agent_id);
    const letter = (agent.display_name.trim()[0] ?? "?").toUpperCase();

    for (const proposal of liveProposals) {
      if (proposal.writer.id !== agent.agent_id || proposal.status !== "draft") continue;
      const docPaths = [...new Set(proposal.sections.map((s) => proposalSectionDocPathForDisplay(s)))];
      events.push({
        id: `${agent.agent_id}-${proposal.id}`,
        agentId: agent.agent_id,
        agentDisplayName: agent.display_name,
        agentAvatarLetter: letter,
        agentAvatarHue: hue,
        action: "submitted",
        targetDescription: proposal.intent,
        timestamp: proposal.created_at,
        documentPreview: docPaths.join(", ") || undefined,
      });
    }

    for (const item of activity) {
      if (item.writer_id !== agent.agent_id) continue;
      const docPaths = [...new Set([...item.sections.map((s) => s.doc_path), ...item.document_paths])];
      events.push({
        id: `${agent.agent_id}-${item.id}`,
        agentId: agent.agent_id,
        agentDisplayName: agent.display_name,
        agentAvatarLetter: letter,
        agentAvatarHue: hue,
        action: "committed",
        targetDescription: item.intent ?? "",
        timestamp: item.opened_at,
        documentPreview: docPaths.join(", ") || undefined,
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
    Promise.all([
      apiClient.getAgentRoster(),
      apiClient.listLiveProposals(),
      apiClient.getActivity(HOME_ACTIVITY_FETCH_LIMIT, HOME_ACTIVITY_FETCH_DAYS),
    ])
      .then(([roster, live, activityRes]) => {
        setEvents(buildFeedEvents(roster, live.proposals, activityRes.items));
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
      <SharedPageHeader title="Agent Activity Feed" backTo="/agents-activity" />

      <div className="px-4 py-2 border-b border-gray-100">
        <Link to="/agents-activity" className="text-xs text-blue-600 hover:underline">
          &larr; Back to Agents
        </Link>
      </div>

      {loading ? (
        <p className="px-4 py-3 text-sm text-gray-500">Loading activity feed...</p>
      ) : null}

      {error ? (
        <p className="px-4 py-3 text-sm text-error">{error}</p>
      ) : null}

      {!loading && !error ? (
        <ActivityFeed events={events} />
      ) : null}
    </section>
  );
}
