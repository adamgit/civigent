import { useCallback, useEffect, useMemo, useState } from "react";
import type { AllSessionStatusesResponse } from "../types/shared.js";
import { apiClient } from "../services/api-client";
import { KnowledgeStoreWsClient } from "../services/ws-client";

const POLL_INTERVAL_MS = 10_000;
const CLOCK_TICK_MS = 1_000;
const STALE_THRESHOLD_SECONDS = 60;

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function secondsSince(timestamp: string | null, nowMs: number): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function formatElapsedShort(totalSeconds: number | null): string {
  if (totalSeconds == null) return "unknown";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m`;
  if (totalSeconds < 86400) return `${Math.floor(totalSeconds / 3600)}h`;
  return `${Math.floor(totalSeconds / 86400)}d`;
}

type Tone = "quiet" | "warning" | "error";

function resolveTone(status: AllSessionStatusesResponse | null, nowMs: number): Tone {
  if (!status || status.outstanding_doc_count === 0) return "quiet";
  const oldestSeconds = secondsSince(status.oldest_outstanding_change_at, nowMs);
  return oldestSeconds !== null && oldestSeconds > STALE_THRESHOLD_SECONDS ? "error" : "warning";
}

export function SessionStatusPill() {
  const [status, setStatus] = useState<AllSessionStatusesResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refreshStatus = useCallback(() => {
    apiClient.getAllSessionStatuses()
      .then((response) => {
        setStatus(response);
        setLoadError(false);
      })
      .catch(() => {
        setLoadError(true);
      });
  }, []);

  useEffect(() => {
    refreshStatus();
    const pollTimer = window.setInterval(refreshStatus, POLL_INTERVAL_MS);
    const clockTimer = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    const wsClient = new KnowledgeStoreWsClient();
    wsClient.connect();
    wsClient.onEvent((event) => {
      if (event.type === "session:status-changed" || event.type === "content:committed") {
        refreshStatus();
      }
    });
    return () => {
      window.clearInterval(pollTimer);
      window.clearInterval(clockTimer);
      wsClient.disconnect();
    };
  }, [refreshStatus]);

  const tone = resolveTone(status, nowMs);
  const oldestSeconds = secondsSince(status?.oldest_outstanding_change_at ?? null, nowMs);
  const lastCommitSeconds = secondsSince(status?.last_commit_at ?? null, nowMs);

  const label = useMemo(() => {
    if (status == null) {
      return loadError ? "Session status unavailable" : "Checking save status...";
    }
    if (status.outstanding_doc_count === 0) {
      return "Everything saved";
    }
    return `${status.outstanding_doc_count} ${pluralize(status.outstanding_doc_count, "doc", "docs")} pending commit, oldest ${formatElapsedShort(oldestSeconds)}`;
  }, [loadError, oldestSeconds, status]);

  const title = useMemo(() => {
    if (status == null) {
      return loadError ? "Could not load session status." : "Loading session status.";
    }
    const lastCommitText = lastCommitSeconds == null ? "unknown" : `${formatElapsedShort(lastCommitSeconds)} ago`;
    if (status.outstanding_doc_count === 0) {
      return `No unpublished session changes. Live sessions: ${status.live_session_count}. Last commit: ${lastCommitText}.`;
    }
    return `Docs pending commit: ${status.outstanding_doc_count}. Live sessions: ${status.live_session_count}. Oldest unpublished change: ${formatElapsedShort(oldestSeconds)}. Last commit: ${lastCommitText}.`;
  }, [lastCommitSeconds, loadError, oldestSeconds, status]);

  const toneClasses =
    tone === "error"
      ? "border-status-red bg-status-red-light text-status-red"
      : tone === "warning"
      ? "border-accent-border bg-accent-light text-accent-text"
      : "border-topbar-border bg-white text-text-muted";

  const dotClasses =
    tone === "error"
      ? "bg-status-red"
      : tone === "warning"
      ? "bg-accent"
      : "bg-black/20";

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none whitespace-nowrap ${toneClasses}`}
      title={title}
      aria-label={label}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClasses}`} />
      <span>{label}</span>
    </div>
  );
}
