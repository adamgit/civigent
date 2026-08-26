import { useCallback, useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type { GetAdminSnapshotHealthResponse, GetAdminSnapshotHistoryResponse, SnapshotRunRecord } from "../types/shared.js";

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function StatusBadge({ ok }: { ok: boolean }) {
  return (
    <span className={`pill ${ok ? "pill-green" : "pill-red"}`}>
      {ok ? "ok" : "error"}
    </span>
  );
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border last:border-0">
      <span className="text-[12px] font-medium text-text-muted w-48 shrink-0">{label}</span>
      <span className="text-[13px] text-text-primary">{children}</span>
    </div>
  );
}

function HistoryRow({ entry }: { entry: SnapshotRunRecord }) {
  if (entry.type === "server_start") {
    return (
      <div className="grid grid-cols-[180px_90px_70px_90px_90px_1fr] gap-x-4 items-center px-4 py-2 border-b border-footer-border last:border-0 text-[12px]">
        <span className="text-text-muted font-mono">{formatTs(entry.timestamp)}</span>
        <span className="italic text-text-muted">server started</span>
        <span />
        <span />
        <span />
        <span className="text-text-muted opacity-60">history resets on restart</span>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[180px_90px_70px_90px_90px_1fr] gap-x-4 items-start px-4 py-2 border-b border-footer-border last:border-0 text-[12px]">
      <span className="text-text-muted font-mono">{formatTs(entry.timestamp)}</span>
      <span className="text-text-secondary">snapshot</span>
      <span className="tabular-nums">
        <span className="text-text-primary">{entry.batch_doc_count ?? "—"}</span>
        {(entry.failed_doc_count ?? 0) > 0 && (
          <span className="text-red-600 ml-1">({entry.failed_doc_count} failed)</span>
        )}
      </span>
      <span className="text-text-primary tabular-nums">{entry.content_file_count ?? "—"}</span>
      <span className="text-text-primary tabular-nums">{entry.snapshot_file_count ?? "—"}</span>
      <span>
        {entry.error ? (
          <details>
            <summary className="cursor-pointer"><StatusBadge ok={false} /></summary>
            <span className="block mt-1 text-red-600 text-[11px] font-mono whitespace-pre-wrap">{entry.error}</span>
          </details>
        ) : (
          <StatusBadge ok={true} />
        )}
      </span>
    </div>
  );
}

export function SnapshotsPage() {
  const [data, setData] = useState<GetAdminSnapshotHistoryResponse | null>(null);
  const [health, setHealth] = useState<GetAdminSnapshotHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshotting, setSnapshotting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [history, snapshotHealth] = await Promise.all([
        apiClient.getAdminSnapshotHistory(),
        apiClient.getAdminSnapshotHealth(),
      ]);
      setData(history);
      setHealth(snapshotHealth);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSnapshotNow = useCallback(async () => {
    setSnapshotting(true);
    setError(null);
    try {
      await apiClient.snapshotNow();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSnapshotting(false);
    }
  }, [load]);

  useEffect(() => { void load(); }, [load]);

  const mostRecent = data?.history.find((e) => e.type === "snapshot") ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SharedPageHeader title="Snapshots" backTo="/admin" />
      <div className="flex-1 min-h-0 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>

        {/* Action bar */}
        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || snapshotting}
            className="text-xs px-3 py-1.5 bg-[#f7f5f1] border border-[#eae7e2] rounded hover:bg-[#eae7e2] text-[#3a3530] disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void handleSnapshotNow()}
            disabled={snapshotting || loading || (data?.snapshot_enabled === true && health?.snapshot_root_writable === false)}
            className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {snapshotting ? "Snapshotting…" : "Snapshot Now"}
          </button>
          {data && (
            <span className="text-[11px] text-text-muted ml-2">
              Snapshots: <strong>{data.snapshot_enabled ? "enabled" : "disabled"}</strong>
            </span>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-[12px] font-mono whitespace-pre-wrap">
            {error}
          </div>
        )}

        {data?.snapshot_enabled && health && !health.snapshot_root_writable && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-[12px]">
            <div className="font-semibold mb-1">Snapshot destination is not writable.</div>
            <div className="font-mono whitespace-pre-wrap">{health.snapshot_root_error ?? `Cannot write to ${health.snapshot_root}`}</div>
            <div className="mt-2">
              Create the host `snapshots/` folder first and grant write permission to the container user before running snapshots.
            </div>
          </div>
        )}

        {loading && !data && (
          <p className="text-xs text-text-muted">Loading...</p>
        )}

        {data && (
          <>
            {/* Current State */}
            <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white mb-4">
              <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
                <div className="text-[13px] font-semibold text-text-primary">Current State</div>
                <div className="text-[11px] text-text-muted">Live counts from disk</div>
              </div>
              <KVRow label="Content files (.md)">{data.current_content_file_count}</KVRow>
              <KVRow label="Snapshot files (.md)">{data.current_snapshot_file_count}</KVRow>
              {health && (
                <>
                  <KVRow label="Snapshot root"><span className="font-mono">{health.snapshot_root}</span></KVRow>
                  <KVRow label="Snapshot destination">
                    {health.snapshot_root_writable ? (
                      <span className="text-green-700 font-medium">writable</span>
                    ) : (
                      <span className="text-red-700 font-medium">not writable</span>
                    )}
                  </KVRow>
                </>
              )}
              <KVRow label="Commits since last snapshot">
                {data.commits_since_last_snapshot === null ? (
                  <em className="text-text-muted">unknown — no snapshot this session</em>
                ) : (
                  <span className={data.commits_since_last_snapshot > 0 ? "text-amber-600 font-semibold" : ""}>
                    {data.commits_since_last_snapshot}
                  </span>
                )}
              </KVRow>
              {mostRecent ? (
                <>
                  <KVRow label="Last snapshot at">{formatTs(mostRecent.timestamp)}</KVRow>
                  <KVRow label="Last batch size">{mostRecent.batch_doc_count ?? "—"} docs</KVRow>
                  <KVRow label="Last snapshot status">
                    {mostRecent.error ? <StatusBadge ok={false} /> : <StatusBadge ok={true} />}
                  </KVRow>
                </>
              ) : (
                <KVRow label="Last snapshot"><em className="text-text-muted">none this session</em></KVRow>
              )}
            </div>

            {/* History */}
            <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white">
              <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
                <div className="text-[13px] font-semibold text-text-primary">History</div>
                <div className="text-[11px] text-text-muted">In-memory only — oldest entry is server start</div>
              </div>
              {/* Column headers */}
              <div className="grid grid-cols-[180px_90px_70px_90px_90px_1fr] gap-x-4 px-4 py-1.5 border-b border-[#eae7e2] bg-[#faf8f5]">
                {["Time", "Event", "Batch", "Content", "Snapshots", "Status"].map((h) => (
                  <span key={h} className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">{h}</span>
                ))}
              </div>
              {data.history.map((entry, i) => (
                <HistoryRow key={i} entry={entry} />
              ))}
            </div>

            {/* Status bar */}
            <div
              className="mt-3 flex items-center gap-1 text-text-muted"
              style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10.5px" }}
            >
              <span>Snapshots</span>
              <span style={{ margin: "0 6px", color: "#d0ccc4" }}>&middot;</span>
              <span>{data.history.filter((e) => e.type === "snapshot").length} snapshot events this session</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
