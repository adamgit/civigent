import { useCallback, useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import {
  apiClient,
  type AgentMcpActionEntry,
  type AgentMcpLogFileInfo,
  type AgentMcpSessionRecord,
} from "../services/api-client";

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString();
}

function resultLabel(result: AgentMcpActionEntry["result"]): { text: string; className: string } {
  switch (result) {
    case "ok":
      return { text: "Succeeded", className: "text-green-600" };
    case "error":
      return { text: "Failed", className: "text-red-500" };
    case "blocked":
      return { text: "Blocked", className: "text-amber-500" };
    default:
      return { text: "Unknown", className: "text-text-muted" };
  }
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
          <div className="grid grid-cols-[180px_160px_90px_1fr] gap-x-4 items-center px-2 py-1 text-[11px] text-text-muted font-medium border-b border-footer-border">
            <span>Time</span>
            <span>Method</span>
            <span>Result</span>
            <span>Metadata</span>
          </div>
          {session.actions.map((action, i) => {
            const label = resultLabel(action.result);
            return (
              <div key={i} className="border-b border-footer-border last:border-0">
                <div className="grid grid-cols-[180px_160px_90px_1fr] gap-x-4 items-start px-2 py-1 text-[11px]">
                  <span className="text-text-muted font-mono">{formatTs(action.ts)}</span>
                  <span className="text-text-primary font-mono">{action.method}</span>
                  <span className={label.className}>{label.text}</span>
                  <span className="text-text-muted font-mono truncate" title={JSON.stringify(action.metadata)}>
                    {Object.keys(action.metadata).length > 0 ? JSON.stringify(action.metadata) : "—"}
                  </span>
                </div>
                {action.result === "error" && action.error_message && (
                  <div className="px-2 pb-1 pl-[196px] text-[11px] text-red-500 font-mono whitespace-pre-wrap break-words">
                    {action.error_message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function AgentMcpLogsPage() {
  const [sessions, setSessions] = useState<AgentMcpSessionRecord[]>([]);
  const [logFile, setLogFile] = useState<AgentMcpLogFileInfo | null>(null);
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
      setLogFile(resp.log_file);
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

        {!loading && !error && logFile && (
          <div className="mb-4 flex items-center justify-between gap-4 rounded border border-footer-border px-4 py-3">
            <div className="min-w-0">
              <div className="text-[11px] font-medium text-text-muted">Server log file</div>
              <code className="block truncate text-[12px] text-text-primary" title={logFile.path}>
                {logFile.path}
              </code>
              <div className="mt-1 text-[11px] text-text-muted tabular-nums">
                {logFile.size_bytes.toLocaleString()} bytes
              </div>
            </div>
            {logFile.exists ? (
              <a
                href="/api/admin/agent-activity/download"
                download
                className="btn-secondary shrink-0 no-underline"
              >
                Download log
              </a>
            ) : (
              <span className="shrink-0 text-[12px] text-text-muted">No file yet</span>
            )}
          </div>
        )}

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
