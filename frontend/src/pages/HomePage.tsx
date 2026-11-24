import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { AppLayoutOutletContext } from "../app/AppLayout";
import { useCurrentUser } from "../contexts/CurrentUserContext";
import { apiClient, resolveWriterId } from "../services/api-client";
import type { ActivityItem, AnyProposal, DocumentTreeEntry, LoginProvider } from "../types/shared.js";
import { useDocLayoutMode } from "../hooks/useDocLayoutMode";
import { useAgentActivityFeeds } from "../hooks/useAgentActivityFeeds";
import {
  combineFeeds,
  loadedFeedDataOr,
  mapLoadedFeed,
  requirePrimaryFeedWithOptionalExtras,
  type Feed,
} from "../utils/feed-state";
import { HomeNarrowLayout } from "./home/HomeNarrowLayout";
import { HomeWideLayout } from "./home/HomeWideLayout";
// Restore the previous wide home with:
// import { HomeWideLayoutClassic as HomeWideLayout } from "./home/HomeWideLayoutClassic";
import {
  HOME_RECENT_WINDOW_DAYS,
  homeFolderWindowDays,
  homeRecentWindowDays,
  readHomeFolderWindow,
  readHomeRecentWindow,
  writeHomeFolderWindow,
  writeHomeRecentWindow,
  type HomeFolderWindowId,
  type HomeRecentWindowId,
} from "./home/home-constants";
import { homeHostLabel, homePageTagline } from "./home/home-title";
import { countTreeTotals } from "./home/home-tree-stats";
import { buildActiveFolders } from "./home/home-folder-activity";
import {
  buildRecentDocuments,
  countRecentDocuments,
  type HomeRecentDocumentsData,
} from "./home/home-recent-documents";
import { buildAgentActivityRows, type HomeAgentRowsData } from "./home/home-agent-activity";
import { formatHomeTime } from "./home/home-time";

const NO_ACTIVITY: ActivityItem[] = [];
const NO_PROPOSALS: AnyProposal[] = [];

export function HomePage() {
  const {
    singleUser,
    setDocLayoutNarrow,
    appName,
    entries,
    treeLoading,
    treeError,
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

  const { roster, activity, proposals, agentPulse, agentReads } = useAgentActivityFeeds();
  const [recentWindowId, setRecentWindowId] = useState<HomeRecentWindowId>(readHomeRecentWindow);
  const [folderWindowId, setFolderWindowId] = useState<HomeFolderWindowId>(readHomeFolderWindow);

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
        setAuthMode(
          type === "single_user" || type === "credentials" || type === "oidc" || type === "local_users"
            ? type
            : null,
        );
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
  const treeFeed = useMemo<Feed<DocumentTreeEntry[]>>(() => {
    if (treeLoading) return { status: "loading" };
    if (treeError) return { status: "failed", error: new Error(treeError) };
    return { status: "loaded", data: entries, refreshError: null };
  }, [treeLoading, treeError, entries]);
  const activityItems = loadedFeedDataOr(activity, NO_ACTIVITY);
  const folderWindowDays = homeFolderWindowDays(folderWindowId);
  const activeFolders = useMemo(
    () =>
      mapLoadedFeed(combineFeeds({ tree: treeFeed, activity }), (data) =>
        buildActiveFolders(data.tree, data.activity, Date.now(), folderWindowDays),
      ),
    [treeFeed, activity, folderWindowDays],
  );
  const lastChangeAt = useMemo(() => {
    let latest = "";
    for (const item of activityItems) {
      if (!latest || Date.parse(item.timestamp) > Date.parse(latest)) latest = item.timestamp;
    }
    return latest || null;
  }, [activityItems]);
  const currentWriterId = currentUser?.id ?? resolveWriterId();
  const recentWindowDays =
    layoutMode === "wide" ? homeRecentWindowDays(recentWindowId) : HOME_RECENT_WINDOW_DAYS;
  const recentDocuments = useMemo(
    () =>
      mapLoadedFeed(activity, (items): HomeRecentDocumentsData => ({
        documents: buildRecentDocuments(items, currentWriterId, Date.now(), recentWindowDays),
        totalCount: countRecentDocuments(items, Date.now(), recentWindowDays),
      })),
    [activity, currentWriterId, recentWindowDays],
  );
  const agentRows = useMemo(
    () =>
      mapLoadedFeed(
        requirePrimaryFeedWithOptionalExtras(roster, {
          proposals: { subject: "proposals", feed: proposals, valueWhileUnavailable: NO_PROPOSALS },
          activity: { subject: "recent activity", feed: activity, valueWhileUnavailable: NO_ACTIVITY },
        }),
        ({ primary, extras, extrasShortfalls }): HomeAgentRowsData => ({
          rows: buildAgentActivityRows(primary.agents, extras.proposals, extras.activity, formatHomeTime),
          extrasShortfalls,
        }),
      ),
    [roster, proposals, activity],
  );
  const involvementPreset = roster.status === "loaded" ? roster.data.posture.preset : null;
  const agentCount = roster.status === "loaded" ? roster.data.agents.length : 0;

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
      agentCount={agentCount}
      lastChangeAt={lastChangeAt}
      folderWindowId={folderWindowId}
      onFolderWindowChange={(id) => {
        setFolderWindowId(id);
        writeHomeFolderWindow(id);
      }}
      recentWindowId={recentWindowId}
      onRecentWindowChange={(id) => {
        setRecentWindowId(id);
        writeHomeRecentWindow(id);
      }}
      agentPulse={agentPulse}
      agentReads={agentReads}
    />
  );
}
