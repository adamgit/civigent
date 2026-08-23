import { useEffect, useMemo, useState } from "react";
import { buildAgentTasks } from "../components/home/experiment/build-agent-tasks";
import { PULSE_FETCH_HOURS } from "../components/home/experiment/build-pulse-hours";
import type { HomeMcpPulseAction } from "../components/home/experiment/types";
import {
  HOME_ACTIVITY_FETCH_DAYS,
  HOME_ACTIVITY_FETCH_LIMIT,
} from "../pages/home/home-constants";
import { apiClient } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import type { ActivityItem, AgentActivitySummary, AnyProposal } from "../types/shared.js";

export function useAgentPulseFeeds() {
  const [agents, setAgents] = useState<readonly AgentActivitySummary[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [proposals, setProposals] = useState<AnyProposal[]>([]);
  const [mcpActions, setMcpActions] = useState<HomeMcpPulseAction[]>([]);
  const [pulseError, setPulseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);

  useEffect(() => {
    let cancelled = false;
    let pending = 3;
    const settle = () => {
      pending -= 1;
      if (pending <= 0 && !cancelled) setLoading(false);
    };

    apiClient
      .getAgentsSummary()
      .then((res) => {
        if (!cancelled) setAgents(res.agents);
      })
      .catch(() => {
        /* mosaic still works from pulse + activity */
      })
      .finally(settle);

    apiClient
      .getActivity(HOME_ACTIVITY_FETCH_LIMIT, HOME_ACTIVITY_FETCH_DAYS)
      .then((res) => {
        if (!cancelled) setActivity(res.items);
      })
      .catch(() => {
        /* pulse actions remain the primary feed */
      })
      .finally(settle);

    apiClient
      .listProposals()
      .then((res) => {
        if (!cancelled) setProposals(res.proposals);
      })
      .catch(() => {
        /* proposals enrich tasks when present */
      })
      .finally(settle);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getAgentMcpPulse(PULSE_FETCH_HOURS)
      .then((res) => {
        if (cancelled) return;
        const fromServer = res.actions ?? [];
        setMcpActions((prev) => {
          const seen = new Set(
            fromServer.map((action) => `${action.agent_id}\0${action.ts}\0${action.method}\0${action.doc_path ?? ""}`),
          );
          const live = prev.filter(
            (action) => !seen.has(`${action.agent_id}\0${action.ts}\0${action.method}\0${action.doc_path ?? ""}`),
          );
          return live.length === 0 ? fromServer : [...fromServer, ...live];
        });
        setPulseError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setMcpActions([]);
        setPulseError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    wsClient.connect();
    let refreshTimer: number | null = null;
    const refreshFeeds = () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        apiClient
          .getActivity(HOME_ACTIVITY_FETCH_LIMIT, HOME_ACTIVITY_FETCH_DAYS)
          .then((res) => setActivity(res.items))
          .catch(() => {
            /* keep last activity */
          });
        apiClient
          .listProposals()
          .then((res) => setProposals(res.proposals))
          .catch(() => {
            /* keep last proposals */
          });
        apiClient
          .getAgentsSummary()
          .then((res) => setAgents(res.agents))
          .catch(() => {
            /* keep last agents */
          });
      }, 180);
    };
    wsClient.onEvent((event) => {
      if (event.type === "agent:reading") {
        setMcpActions((prev) => [
          ...prev,
          {
            agent_id: event.actor_id,
            agent_display_name: event.actor_display_name,
            method: "read_doc",
            ts: new Date().toISOString(),
            doc_path: event.doc_path,
            heading_path: event.heading_paths[0] ?? null,
          },
        ]);
        return;
      }
      if (
        event.type === "content:committed" ||
        event.type === "proposal:draft" ||
        event.type === "proposal:inprogress" ||
        event.type === "proposal:withdrawn"
      ) {
        refreshFeeds();
      }
    });
    return () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      wsClient.disconnect();
    };
  }, [wsClient]);

  const agentTasks = useMemo(
    () => buildAgentTasks(proposals, mcpActions, agents, activity),
    [proposals, mcpActions, agents, activity],
  );

  return { mcpActions, activity, agentTasks, pulseError, loading };
}
