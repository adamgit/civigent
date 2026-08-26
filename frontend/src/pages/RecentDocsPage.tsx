import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { PageStatusBar } from "../components/PageStatusBar";
import { HomeRecentDocumentsSection } from "../components/home/HomeRecentDocumentsSection";
import { useCurrentUser } from "../contexts/CurrentUserContext";
import { useDocLayoutMode } from "../hooks/useDocLayoutMode";
import { apiClient, resolveWriterId } from "../services/api-client";
import type { ActivityItem } from "../types/shared.js";
import { buildRecentDocuments, countRecentDocuments } from "./home/home-recent-documents";
import {
  HOME_ACTIVITY_FETCH_DAYS,
  HOME_ACTIVITY_FETCH_LIMIT,
  parseHomeRecentWindowId,
  readHomeRecentWindow,
  writeHomeRecentWindow,
  homeRecentWindowDays,
  type HomeRecentWindowId,
} from "./home/home-constants";
import "./home/home.css";

export function RecentDocsPage() {
  const layoutMode = useDocLayoutMode();
  const currentUser = useCurrentUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const windowId = parseHomeRecentWindowId(searchParams.get("window")) ?? readHomeRecentWindow();
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get("window")) return;
    setSearchParams({ window: windowId }, { replace: true });
  }, [searchParams, setSearchParams, windowId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient
      .getActivity(HOME_ACTIVITY_FETCH_LIMIT, HOME_ACTIVITY_FETCH_DAYS)
      .then((res) => {
        if (cancelled) return;
        setActivity(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const currentWriterId = currentUser?.id ?? resolveWriterId();
  const windowDays = homeRecentWindowDays(windowId);
  const documents = useMemo(
    () => buildRecentDocuments(activity, currentWriterId, Date.now(), windowDays),
    [activity, currentWriterId, windowDays],
  );
  const totalCount = useMemo(
    () => countRecentDocuments(activity, Date.now(), windowDays),
    [activity, windowDays],
  );

  const handleWindowChange = (id: HomeRecentWindowId) => {
    writeHomeRecentWindow(id);
    setSearchParams({ window: id }, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SharedPageHeader title="Recent Documents" backTo="/" />
      <div className="flex-1 min-h-0 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        {loading && <p className="text-xs text-text-muted">Loading recent documents...</p>}
        {error && <p className="text-error text-xs">{error}</p>}
        {!loading && !error && (
          <HomeRecentDocumentsSection
            documents={documents}
            totalCount={totalCount}
            layoutMode={layoutMode}
            windowId={windowId}
            onWindowChange={handleWindowChange}
            showAllLink={false}
            hideWhenEmpty={false}
          />
        )}
      </div>
      <PageStatusBar items={["Recent", loading ? "Loading" : `${totalCount} documents`]} />
    </div>
  );
}
