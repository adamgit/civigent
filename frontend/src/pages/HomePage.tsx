import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { AppLayoutOutletContext } from "../app/AppLayout";
import { useCurrentUser } from "../contexts/CurrentUserContext";
import { apiClient, resolveWriterId } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";
import { type AgentActivitySummary, type ActivityItem, type AnyProposal, type HumanInvolvementPresetName, type LoginProvider } from "../types/shared.js";
import { useDocLayoutMode } from "../hooks/useDocLayoutMode";
import { HomeNarrowLayout } from "./home/HomeNarrowLayout";
import { HomeWideLayout } from "./home/HomeWideLayout";
import {
  HOME_ACTIVITY_FETCH_DAYS,
  HOME_ACTIVITY_FETCH_LIMIT,
  HOME_FOLDER_WINDOW_DEFAULT,
  HOME_RECENT_WINDOW_DAYS,
  homeFolderWindowDays,
  homeRecentWindowDays,
  readHomeRecentWindow,
  writeHomeRecentWindow,
  type HomeFolderWindowId,
  type HomeRecentWindowId,
} from "./home/home-constants";
import { homeHostLabel, homePageTagline } from "./home/home-title";
import { countTreeTotals } from "./home/home-tree-stats";
import { buildActiveFolders } from "./home/home-folder-activity";
import { buildRecentDocuments, countRecentDocuments } from "./home/home-recent-documents";
import { buildAgentActivityRows } from "./home/home-agent-activity";
import { buildAgentTasks } from "../components/home/experiment/build-agent-tasks";
import { PULSE_FETCH_HOURS } from "../components/home/experiment/build-pulse-hours";
import type { HomeMcpPulseAction } from "../components/home/experiment/types";
import { formatHomeTime } from "./home/home-time";

export function HomePage() {
  const {
    singleUser,
    sidebarAutoHide,
    setSidebarAutoHide,
    setDocLayoutNarrow,
    appName,
    entries,
  } = useOutletContext<AppLayoutOutletContext>();
  const layoutMode = useDocLayoutMode();
  useLayoutEffect(() => {
    setDocLayoutNarrow(layoutMode === "narrow");
    return () => setDocLayoutNarrow(false);
  }, [layoutMode, setDocLayoutNarrow]);

  const currentUser = useCurrentUser();

  const [degradedCount, setDegradedCount] = useState(0);
  const [degradedError, setDegradedError] = useState<string | null>(null);

  const [authMode, setAuthMode] = useState<LoginProvider | null>(null);
  const [bootstrapAvailable, setBootstrapAvailable] = useState(false);
  const [bootstrapCode, setBootstrapCode] = useState("");
  const [bootstrapWorking, setBootstrapWorking] = useState(false);
  const [bootstrapMessage, setBootstrapMessage] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const [involvementPreset, setInvolvementPreset] = useState<HumanInvolvementPresetName | null>(null);
  const [agents, setAgents] = useState<readonly AgentActivitySummary[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<AnyProposal[]>([]);
  const [recentWindowId, setRecentWindowId] = useState<HomeRecentWindowId>(readHomeRecentWindow);
  const [folderWindowId, setFolderWindowId] = useState<HomeFolderWindowId>(HOME_FOLDER_WINDOW_DEFAULT);
  const [proposalsError, setProposalsError] = useState<string | null>(null);
  const [mcpActions, setMcpActions] = useState<HomeMcpPulseAction[]>([]);
  const [pulseError, setPulseError] = useState<string | null>(null);
  const wsClient = useMemo(() => new KnowledgeStoreWsClient(), []);

  useEffect(() => {
    if (!currentUser?.is_admin) {
      setDegradedCount(0);
      setDegradedError(null);
      return;
    }
    let cancelled = false;
    apiClient
      .listDegradedProposals()
      .then((res) => {
        if (!cancelled) {
          setDegradedCount(res.proposals.length + res.undecodable.length);
          setDegradedError(null);
        }
      })
      .catch((err) => { if (!cancelled) setDegradedError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [currentUser?.is_admin]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getAuthMethods()
      .then((response) => {
        if (cancelled) return;
        setBootstrapAvailable(!!response.bootstrap_available);
        const type = response.methods?.[0]?.type;
        setAuthMode(type === "single_user" || type === "credentials" || type === "oidc" ? type : null);
      })
      .catch(() => {
        /* non-fatal background fetch */
        if (!cancelled) {
          setBootstrapAvailable(false);
          setAuthMode(null);
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getAgentsSummary()
      .then((res) => {
        if (!cancelled) {
          setInvolvementPreset(res.posture.preset);
          setAgents(res.agents);
          setAgentsError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setAgentsError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getActivity(HOME_ACTIVITY_FETCH_LIMIT, HOME_ACTIVITY_FETCH_DAYS)
      .then((res) => {
        if (!cancelled) {
          setActivity(res.items);
          setActivityError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setActivityError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .listProposals()
      .then((res) => {
        if (!cancelled) {
          setProposals(res.proposals);
          setProposalsError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setProposalsError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getAgentMcpPulse(PULSE_FETCH_HOURS)
      .then((res) => {
        if (!cancelled) {
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
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setMcpActions([]);
          setPulseError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    wsClient.connect();
    let refreshTimer: number | null = null;
    const refreshFeeds = () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        apiClient
          .getActivity(HOME_ACTIVITY_FETCH_LIMIT, HOME_ACTIVITY_FETCH_DAYS)
          .then((res) => {
            setActivity(res.items);
            setActivityError(null);
          })
          .catch((err) => { setActivityError(err instanceof Error ? err.message : String(err)); });
        apiClient
          .listProposals()
          .then((res) => {
            setProposals(res.proposals);
            setProposalsError(null);
          })
          .catch((err) => { setProposalsError(err instanceof Error ? err.message : String(err)); });
        apiClient
          .getAgentsSummary()
          .then((res) => {
            setInvolvementPreset(res.posture.preset);
            setAgents(res.agents);
            setAgentsError(null);
          })
          .catch((err) => { setAgentsError(err instanceof Error ? err.message : String(err)); });
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

  const handleBootstrap = async () => {
    setBootstrapWorking(true);
    setBootstrapMessage(null);
    setBootstrapError(null);
    try {
      await apiClient.bootstrap(bootstrapCode);
      setBootstrapMessage("Admin role granted. You can now access admin features.");
      setBootstrapAvailable(false);
      setBootstrapCode("");
    } catch (err) {
      setBootstrapError(err instanceof Error ? err.message : String(err));
    } finally {
      setBootstrapWorking(false);
    }
  };

  const treeTotals = useMemo(() => countTreeTotals(entries), [entries]);
  const folderWindowDays = homeFolderWindowDays(folderWindowId);
  const activeFolders = useMemo(
    () => buildActiveFolders(entries, activity, proposals, Date.now(), folderWindowDays),
    [entries, activity, proposals, folderWindowDays],
  );
  const lastChangeAt = useMemo(() => {
    let latest = "";
    for (const item of activity) {
      if (!latest || Date.parse(item.timestamp) > Date.parse(latest)) latest = item.timestamp;
    }
    return latest || null;
  }, [activity]);
  const currentWriterId = currentUser?.id ?? resolveWriterId();
  const recentWindowDays =
    layoutMode === "wide" ? homeRecentWindowDays(recentWindowId) : HOME_RECENT_WINDOW_DAYS;
  const recentWriterType = layoutMode === "wide" ? "human" : undefined;
  const recentDocuments = useMemo(
    () => buildRecentDocuments(activity, currentWriterId, Date.now(), recentWindowDays, recentWriterType),
    [activity, currentWriterId, recentWindowDays, recentWriterType],
  );
  const recentDocumentTotal = useMemo(
    () => countRecentDocuments(activity, Date.now(), recentWindowDays, recentWriterType),
    [activity, recentWindowDays, recentWriterType],
  );
  const agentRows = useMemo(
    () => buildAgentActivityRows(agents, formatHomeTime),
    [agents],
  );
  const agentTasks = useMemo(
    () => buildAgentTasks(proposals, mcpActions, agents, activity),
    [proposals, mcpActions, agents, activity],
  );

  const alerts = (
    <>
      {degradedCount > 0 && (
        <div
          role="alert"
          data-testid="degraded-proposals-alert"
          className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-800"
        >
          <strong>{degradedCount}</strong> {degradedCount === 1 ? "proposal needs" : "proposals need"} admin review.{" "}
          <Link to="/admin/proposals" className="font-medium underline">
            Review on Proposals &rarr;
          </Link>
        </div>
      )}
      {degradedError && (
        <p className="text-error" style={{ marginBottom: "1rem" }}>
          Could not check for degraded proposals: {degradedError}
        </p>
      )}
      {agentsError && (
        <p className="text-error" style={{ marginBottom: "1rem" }}>
          Could not load agents: {agentsError}
        </p>
      )}
      {activityError && (
        <p className="text-error" style={{ marginBottom: "1rem" }}>
          Could not load recent activity: {activityError}
        </p>
      )}
      {proposalsError && (
        <p className="text-error" style={{ marginBottom: "1rem" }}>
          Could not load proposals: {proposalsError}
        </p>
      )}
      {bootstrapAvailable && currentUser && (
        <div
          role="region"
          aria-label="Bootstrap admin"
          data-testid="bootstrap-admin"
          style={{
            marginBottom: "1.75rem",
            background: "var(--color-sidebar-bg)",
            borderRadius: 12,
            padding: "14px 18px",
            border: "1px solid var(--color-footer-border)",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>
            Bootstrap admin
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 8 }}>
            No admin users exist. Enter the one-time bootstrap code from the server console to claim admin for your signed-in account.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={bootstrapCode}
              onChange={(e) => setBootstrapCode(e.target.value)}
              placeholder="Paste bootstrap code"
              className="input-field"
              style={{ flex: 1, height: 34 }}
              disabled={bootstrapWorking}
            />
            <button
              type="button"
              onClick={() => void handleBootstrap()}
              disabled={bootstrapWorking || !bootstrapCode.trim()}
              className="btn-primary"
              style={{ height: 34, opacity: bootstrapCode.trim() ? 1 : 0.5, whiteSpace: "nowrap" }}
            >
              Claim admin
            </button>
          </div>
          {bootstrapMessage && <p className="text-xs text-green-700" style={{ marginTop: 8 }}>{bootstrapMessage}</p>}
          {bootstrapError && <p data-testid="bootstrap-error" className="text-error" style={{ marginTop: 8 }}>{bootstrapError}</p>}
        </div>
      )}
    </>
  );

  const hostLabel = homeHostLabel();
  const layoutProps = {
    hostLabel,
    involvementPreset,
    folders: activeFolders,
    recentDocuments,
    recentDocumentTotal,
    alerts,
    singleUser,
    authMode: authMode ?? (singleUser ? "single_user" : null),
  };

  if (layoutMode === "narrow") {
    return (
      <HomeNarrowLayout
        {...layoutProps}
        title={hostLabel}
        agentRows={agentRows}
        folderCount={treeTotals.folderCount}
        documentCount={treeTotals.documentCount}
      />
    );
  }

  return (
    <HomeWideLayout
      {...layoutProps}
      tagline={homePageTagline(appName)}
      documentCount={treeTotals.documentCount}
      folderCount={treeTotals.folderCount}
      agentCount={agents.length}
      lastChangeAt={lastChangeAt}
      folderWindowId={folderWindowId}
      onFolderWindowChange={setFolderWindowId}
      recentWindowId={recentWindowId}
      onRecentWindowChange={(id) => {
        setRecentWindowId(id);
        writeHomeRecentWindow(id);
      }}
      sidebarAutoHide={sidebarAutoHide}
      setSidebarAutoHide={setSidebarAutoHide}
      mcpActions={mcpActions}
      pulseActivity={activity}
      agentTasks={agentTasks}
      pulseError={pulseError}
    />
  );
}
