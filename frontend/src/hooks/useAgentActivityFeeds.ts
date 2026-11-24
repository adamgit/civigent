import { useEffect, useMemo, useState } from "react";
import { buildAgentTasks } from "../components/home/experiment/build-agent-tasks";
import { PULSE_FETCH_HOURS } from "../components/home/experiment/build-pulse-hours";
import type { HomeAgentTask, HomeMcpPulseAction } from "../components/home/experiment/types";
import {
  HOME_ACTIVITY_FETCH_DAYS,
  HOME_ACTIVITY_FETCH_LIMIT,
} from "../pages/home/home-constants";
import { apiClient } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import type { ActivityItem, AgentRead, AnyProposal, GetAgentRosterResponse } from "../types/shared.js";
import {
  mapLoadedFeed,
  requirePrimaryFeedWithOptionalExtras,
  type Feed,
  type OptionalFeedShortfall,
} from "../utils/feed-state";
import { useRefreshableFeed } from "./useRefreshableFeed";

const WS_REFRESH_DEBOUNCE_MS = 180;

const fetchAgentRoster = (): Promise<GetAgentRosterResponse> => apiClient.getAgentRoster();

const fetchActivityItems = (): Promise<ActivityItem[]> =>
  apiClient.getActivity(HOME_ACTIVITY_FETCH_LIMIT, HOME_ACTIVITY_FETCH_DAYS).then((res) => res.items);

const fetchLiveProposals = (): Promise<AnyProposal[]> =>
  apiClient.listLiveProposals().then((res) => res.proposals);

const fetchMcpPulseActions = (): Promise<HomeMcpPulseAction[]> =>
  apiClient.getAgentMcpPulse(PULSE_FETCH_HOURS).then((res) => res.actions);

const NO_ACTIVITY: ActivityItem[] = [];
const NO_PROPOSALS: AnyProposal[] = [];
const NO_ROSTER_AGENTS: GetAgentRosterResponse["agents"] = [];

export interface AgentPulseData {
  actions: HomeMcpPulseAction[];
  activity: ActivityItem[];
  tasks: HomeAgentTask[];
  extrasShortfalls: OptionalFeedShortfall[];
}

export interface AgentActivityFeeds {
  roster: Feed<GetAgentRosterResponse>;
  activity: Feed<ActivityItem[]>;
  proposals: Feed<AnyProposal[]>;
  agentPulse: Feed<AgentPulseData>;
  agentReads: AgentRead[];
}

export function useAgentActivityFeeds(): AgentActivityFeeds {
  const roster = useRefreshableFeed(fetchAgentRoster);
  const activity = useRefreshableFeed(fetchActivityItems);
  const proposals = useRefreshableFeed(fetchLiveProposals);
  const mcpPulse = useRefreshableFeed(fetchMcpPulseActions);
  const [agentReads, setAgentReads] = useState<AgentRead[]>([]);
  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);

  const refreshRoster = roster.refreshKeepingShownData;
  const refreshActivity = activity.refreshKeepingShownData;
  const refreshProposals = proposals.refreshKeepingShownData;

  useEffect(() => {
    wsClient.connect();
    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshActivity();
        refreshProposals();
        refreshRoster();
      }, WS_REFRESH_DEBOUNCE_MS);
    };
    wsClient.onEvent((event) => {
      if (event.type === "agent:reading") {
        const { type: _type, ...read } = event;
        setAgentReads((prev) => [...prev, read]);
        return;
      }
      if (
        event.type === "content:committed" ||
        event.type === "proposal:draft" ||
        event.type === "proposal:inprogress" ||
        event.type === "proposal:withdrawn"
      ) {
        scheduleRefresh();
      }
    });
    return () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      wsClient.disconnect();
    };
  }, [wsClient, refreshActivity, refreshProposals, refreshRoster]);

  const agentPulse = useMemo(
    () =>
      mapLoadedFeed(
        requirePrimaryFeedWithOptionalExtras(mcpPulse.feed, {
          agents: {
            subject: "agent list",
            feed: mapLoadedFeed(roster.feed, (data) => data.agents),
            valueWhileUnavailable: NO_ROSTER_AGENTS,
          },
          activity: { subject: "recent activity", feed: activity.feed, valueWhileUnavailable: NO_ACTIVITY },
          proposals: { subject: "proposals", feed: proposals.feed, valueWhileUnavailable: NO_PROPOSALS },
        }),
        ({ primary: actions, extras, extrasShortfalls }): AgentPulseData => ({
          actions,
          activity: extras.activity,
          tasks: buildAgentTasks(extras.proposals, actions, agentReads, extras.agents, extras.activity),
          extrasShortfalls,
        }),
      ),
    [roster.feed, activity.feed, proposals.feed, mcpPulse.feed, agentReads],
  );

  return {
    roster: roster.feed,
    activity: activity.feed,
    proposals: proposals.feed,
    agentPulse,
    agentReads,
  };
}
