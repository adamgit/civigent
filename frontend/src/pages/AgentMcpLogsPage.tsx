import { useCallback, useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import {
  apiClient,
  type AgentMcpActionEntry,
  type AgentMcpLogFileInfo,
  type AgentMcpSessionRecord,
} from "../services/api-client";
import type { RunAdminMcpLogAnalysisResponse } from "../types/shared.js";

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString();
}

function resultLabel(result: AgentMcpActionEntry["result"]): { text: string; className: string } {
  switch (result) {
    case "ok":
      return { text: "Succeeded", className: "text-status-green" };
    case "error":
      return { text: "Failed", className: "text-status-red" };
    case "blocked":
      return { text: "Blocked", className: "text-status-yellow" };
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

function formatSlotSequence(slots: RunAdminMcpLogAnalysisResponse["workflows"][number]["slots"]): string {
  return slots.map((slot) => (slot.multiplicity === "2+" ? `${slot.method} ×2+` : slot.method)).join(" → ");
}

function formatSlotNs(slotNs: RunAdminMcpLogAnalysisResponse["workflows"][number]["slot_ns"]): string {
  return slotNs.map((entry) => `${entry.method}×${entry.n}: ${entry.sittings}`).join(", ");
}

function formatCountBuckets(buckets: RunAdminMcpLogAnalysisResponse["workflows"][number]["errors_per_sitting"]): string {
  return buckets.map((bucket) => `${bucket.label}: ${bucket.count}`).join(", ");
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
        className="w-full grid grid-cols-[200px_160px_120px_80px_1fr] gap-x-4 items-center px-4 py-2 text-left hover:bg-section-hover cursor-pointer text-[12px]"
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
                  <div className="px-2 pb-1 pl-[196px] text-[11px] text-status-red font-mono whitespace-pre-wrap break-words">
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
  const [analysis, setAnalysis] = useState<RunAdminMcpLogAnalysisResponse | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const next = await apiClient.runAdminMcpLogAnalysis();
      setAnalysis(next);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }, []);

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

      <div className="max-w-6xl mx-auto px-4 py-6 font-ui">
        {loading && <p className="text-text-muted text-[13px]">Loading...</p>}
        {error && <p className="text-status-red text-[13px]">{error}</p>}

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

        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <button
              type="button"
              onClick={() => void runAnalysis()}
              disabled={analyzing}
              className="btn-primary disabled:opacity-50"
            >
              {analyzing ? "Analyzing…" : "Run analysis"}
            </button>
            {analysis && !analyzing && (
              <span className="text-[11px] text-text-muted ml-2">
                {analysis.sitting_count} sittings analyzed in {analysis.duration_ms}ms
              </span>
            )}
          </div>

          {analysisError && <p className="text-status-red text-[13px] mb-3">{analysisError}</p>}

          {analysis && (
            <div className="space-y-6">
              <div className="border border-footer-border rounded overflow-x-auto">
                <div className="px-4 py-2 text-[12px] font-semibold text-text-primary border-b border-footer-border">
                  Workflows
                </div>
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-text-muted font-medium border-b border-footer-border">
                      <th className="text-left px-3 py-1.5">Pattern</th>
                      <th className="text-right px-3 py-1.5">Instances</th>
                      <th className="text-right px-3 py-1.5">Total errors</th>
                      <th className="text-left px-3 py-1.5">Errors / sitting</th>
                      <th className="text-left px-3 py-1.5">2+ slot n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.workflows.length === 0 ? (
                      <tr>
                        <td className="px-3 py-2 text-text-muted" colSpan={5}>
                          No workflow cohorts.
                        </td>
                      </tr>
                    ) : (
                      analysis.workflows.map((cohort, i) => (
                        <tr key={i} className="border-b border-footer-border last:border-0">
                          <td className="px-3 py-1.5 font-mono text-text-primary">{formatSlotSequence(cohort.slots)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-text-primary">{cohort.instance_count}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-text-primary">{cohort.total_errors}</td>
                          <td className="px-3 py-1.5 font-mono text-text-muted">{formatCountBuckets(cohort.errors_per_sitting)}</td>
                          <td className="px-3 py-1.5 font-mono text-text-muted">{formatSlotNs(cohort.slot_ns) || "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="border border-footer-border rounded overflow-x-auto">
                <div className="px-4 py-2 text-[12px] font-semibold text-text-primary border-b border-footer-border">
                  Errors
                </div>
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-text-muted font-medium border-b border-footer-border">
                      <th className="text-left px-3 py-1.5">Method</th>
                      <th className="text-left px-3 py-1.5">Result</th>
                      <th className="text-left px-3 py-1.5">Cause</th>
                      <th className="text-right px-3 py-1.5">Instances</th>
                      <th className="text-right px-3 py-1.5">Once</th>
                      <th className="text-right px-3 py-1.5">Repeated</th>
                      <th className="text-right px-3 py-1.5">Recovered</th>
                      <th className="text-right px-3 py-1.5">Unresolved</th>
                      <th className="text-right px-3 py-1.5">Abandoned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.errors.length === 0 ? (
                      <tr>
                        <td className="px-3 py-2 text-text-muted" colSpan={9}>
                          No error cohorts.
                        </td>
                      </tr>
                    ) : (
                      analysis.errors.map((cohort, i) => (
                        <tr key={i} className="border-b border-footer-border last:border-0">
                          <td className="px-3 py-1.5 font-mono text-text-primary">{cohort.method}</td>
                          <td className="px-3 py-1.5">{cohort.result}</td>
                          <td className="px-3 py-1.5 font-mono text-text-muted break-words">{cohort.cause_template}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{cohort.instance_count}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{cohort.sittings_once}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{cohort.sittings_repeated}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-status-green">{cohort.recovered}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-status-yellow">{cohort.unresolved}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-status-red">{cohort.abandoned}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="border border-footer-border rounded overflow-x-auto">
                <div className="px-4 py-2 text-[12px] font-semibold text-text-primary border-b border-footer-border">
                  Argument-shape failures
                </div>
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-text-muted font-medium border-b border-footer-border">
                      <th className="text-left px-3 py-1.5">Method</th>
                      <th className="text-left px-3 py-1.5">Cause</th>
                      <th className="text-left px-3 py-1.5">Doc path</th>
                      <th className="text-right px-3 py-1.5">Instances</th>
                      <th className="text-left px-3 py-1.5">Sample</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.arg_shapes.length === 0 ? (
                      <tr>
                        <td className="px-3 py-2 text-text-muted" colSpan={5}>
                          No argument-shape failures.
                        </td>
                      </tr>
                    ) : (
                      analysis.arg_shapes.map((cohort, i) => (
                        <tr key={i} className="border-b border-footer-border last:border-0">
                          <td className="px-3 py-1.5 font-mono text-text-primary">{cohort.method}</td>
                          <td className="px-3 py-1.5 font-mono text-text-muted break-words">{cohort.cause_template}</td>
                          <td className="px-3 py-1.5 font-mono text-text-muted break-all">{cohort.doc_path ?? "—"}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{cohort.instance_count}</td>
                          <td className="px-3 py-1.5 font-mono text-text-muted break-words">{cohort.sample_error_message}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="border border-footer-border rounded overflow-x-auto">
                <div className="px-4 py-2 text-[12px] font-semibold text-text-primary border-b border-footer-border">
                  Tool counts
                </div>
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-text-muted font-medium border-b border-footer-border">
                      <th className="text-left px-3 py-1.5">Method</th>
                      <th className="text-left px-3 py-1.5">Tier (inferred)</th>
                      <th className="text-right px-3 py-1.5">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.tool_counts.length === 0 ? (
                      <tr>
                        <td className="px-3 py-2 text-text-muted" colSpan={3}>
                          No tool calls.
                        </td>
                      </tr>
                    ) : (
                      analysis.tool_counts.map((entry) => (
                        <tr key={entry.method} className="border-b border-footer-border last:border-0">
                          <td className="px-3 py-1.5 font-mono text-text-primary">{entry.method}</td>
                          <td className="px-3 py-1.5 text-text-muted">{entry.inferred_tier}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{entry.count}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
