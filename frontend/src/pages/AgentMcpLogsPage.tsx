import { useCallback, useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient, type AgentMcpSessionRecord } from "../services/api-client";

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString();
}

function durationMs(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function SessionRow({
  session,
  expanded,
  onToggle,
}: {
  session: AgentMcpSessionRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-footer-border last:border-0">
      <button
        type="button"
        onClick={onToggle}
        className="w-full grid grid-cols-[200px_160px_120px_80px_1fr] gap-x-4 items-center px-4 py-2 text-left hover:bg-[rgba(255,255,255,0.03)] cursor-pointer text-[12px]"
      >
        <span className="text-text-muted font-mono truncate" title={session.session_id}>
          {session.session_id.slice(0, 8)}...
        </span>
        <span className="text-text-primary">{session.agent_display_name}</span>
        <span className="text-text-muted font-mono">{formatTs(session.started_at)}</span>
        <span className="text-text-muted tabular-nums">{durationMs(session.started_at, session.ended_at)}</span>
        <span className="text-text-primary tabular-nums">{session.action_count} calls</span>
      </button>

      {expanded && (
        <div className="px-6 pb-3">
          <div className="grid grid-cols-[180px_160px_1fr] gap-x-4 items-center px-2 py-1 text-[11px] text-text-muted font-medium border-b border-footer-border">
            <span>Time</span>
            <span>Method</span>
            <span>Metadata</span>
          </div>
          {session.actions.map((action, i) => (
            <div
              key={i}
              className="grid grid-cols-[180px_160px_1fr] gap-x-4 items-start px-2 py-1 text-[11px] border-b border-footer-border last:border-0"
            >
              <span className="text-text-muted font-mono">{formatTs(action.ts)}</span>
              <span className="text-text-primary font-mono">{action.method}</span>
              <span className="text-text-muted font-mono truncate" title={JSON.stringify(action.metadata)}>
                {Object.keys(action.metadata).length > 0 ? JSON.stringify(action.metadata) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentMcpLogsPage() {
  const [sessions, setSessions] = useState<AgentMcpSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await apiClient.getAgentActivity();
      // Show most recent first
      setSessions(resp.sessions.reverse());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <SharedPageHeader title="Agent MCP Logs" backTo="/admin" />

      <div style={{ maxWidth: "72rem", margin: "0 auto", padding: "1.5rem 1rem" }}>
        {loading && <p className="text-text-muted text-[13px]">Loading...</p>}
        {error && <p className="text-red-500 text-[13px]">{error}</p>}

        {!loading && !error && sessions.length === 0 && (
          <p className="text-text-muted text-[13px]">No agent MCP sessions recorded yet.</p>
        )}

        {!loading && sessions.length > 0 && (
          <div className="border border-footer-border rounded">
            <div className="grid grid-cols-[200px_160px_120px_80px_1fr] gap-x-4 items-center px-4 py-2 text-[11px] text-text-muted font-medium border-b border-footer-border">
              <span>Session</span>
              <span>Agent</span>
              <span>Started</span>
              <span>Duration</span>
              <span>Actions</span>
            </div>
            {sessions.map((s) => (
              <SessionRow
                key={s.session_id}
                session={s}
                expanded={expandedId === s.session_id}
                onToggle={() => setExpandedId(expandedId === s.session_id ? null : s.session_id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
