import { useCallback, useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type {
  CountBucket,
  McpLogErrorCohort,
  RunAdminMcpLogAnalysisResponse,
  WorkflowPatternSlot,
  WorkflowSlotNCount,
} from "../types/shared.js";

function formatSlotSequence(slots: WorkflowPatternSlot[]): string {
  return slots.map((slot) => (slot.multiplicity === "2+" ? `${slot.method} ×2+` : slot.method)).join(" → ");
}

function formatSlotNs(slotNs: WorkflowSlotNCount[]): string {
  return slotNs.map((entry) => `${entry.method}×${entry.n}: ${entry.sittings}`).join(", ");
}

function formatCountBuckets(buckets: CountBucket[]): string {
  return buckets.map((bucket) => `${bucket.label}: ${bucket.count}`).join(", ");
}

function ErrorRow({ cohort, index }: { cohort: McpLogErrorCohort; index: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr
        className="border-b border-footer-border last:border-0 cursor-pointer hover:bg-section-hover"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-3 py-1.5 font-mono text-text-primary">
          {expanded ? "▾" : "▸"} {cohort.method}
        </td>
        <td className="px-3 py-1.5">{cohort.result}</td>
        <td className="px-3 py-1.5 font-mono text-text-muted break-words">{cohort.cause_template}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{cohort.instance_count}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{cohort.sittings_once}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{cohort.sittings_repeated}</td>
        <td className="px-3 py-1.5 text-right tabular-nums text-status-green">{cohort.recovered}</td>
        <td className="px-3 py-1.5 text-right tabular-nums text-status-yellow">{cohort.unresolved}</td>
        <td className="px-3 py-1.5 text-right tabular-nums text-status-red">{cohort.abandoned}</td>
      </tr>
      {expanded &&
        cohort.agents.map((agent) => (
          <tr key={`${index}-${agent.agent_id}`} className="border-b border-footer-border last:border-0 bg-section-hover/40">
            <td className="px-3 py-1 pl-8 font-mono text-text-muted" colSpan={2} title={agent.agent_id}>
              {agent.agent_display_name}
            </td>
            <td className="px-3 py-1 text-text-muted">—</td>
            <td className="px-3 py-1 text-right tabular-nums">{agent.instance_count}</td>
            <td className="px-3 py-1 text-right tabular-nums">{agent.sittings_once}</td>
            <td className="px-3 py-1 text-right tabular-nums">{agent.sittings_repeated}</td>
            <td className="px-3 py-1 text-right tabular-nums text-status-green">{agent.recovered}</td>
            <td className="px-3 py-1 text-right tabular-nums text-status-yellow">{agent.unresolved}</td>
            <td className="px-3 py-1 text-right tabular-nums text-status-red">{agent.abandoned}</td>
          </tr>
        ))}
    </>
  );
}

export function AgentMcpAnalysisPage() {
  const [report, setReport] = useState<RunAdminMcpLogAnalysisResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAnalysis = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const next = await apiClient.runAdminMcpLogAnalysis();
      setReport(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    void runAnalysis();
  }, [runAnalysis]);

  return (
    <div>
      <SharedPageHeader title="Agent MCP Analysis" backTo="/admin" />

      <div className="max-w-6xl mx-auto px-4 py-6 font-ui">
        <div className="mb-4 flex items-center justify-between gap-4 rounded border border-footer-border px-4 py-3">
          <div className="min-w-0">
            {report && (
              <>
                <div className="text-[11px] font-medium text-text-muted">Server log file</div>
                <code className="block truncate text-[12px] text-text-primary" title={report.log_file.path}>
                  {report.log_file.path}
                </code>
                <div className="mt-1 text-[11px] text-text-muted tabular-nums">
                  {report.log_file.size_bytes.toLocaleString()} bytes
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {report && !running && (
              <span className="text-[11px] text-text-muted">
                {report.sitting_count} sittings analyzed in {report.duration_ms}ms
              </span>
            )}
            {report?.log_file.exists && (
              <a href="/api/admin/agent-activity/download" download className="btn-secondary no-underline">
                Download log
              </a>
            )}
            <button
              type="button"
              onClick={() => void runAnalysis()}
              disabled={running}
              className="btn-primary disabled:opacity-50"
            >
              {running ? "Analyzing…" : "Run analysis"}
            </button>
          </div>
        </div>

        {error && <p className="text-status-red text-[13px] mb-4">{error}</p>}

        {report && (
          <div className="space-y-6">
            <div className="border border-footer-border rounded overflow-x-auto">
              <div className="px-4 py-2 text-[12px] font-semibold text-text-primary border-b border-footer-border">
                Fragments
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-text-muted font-medium border-b border-footer-border">
                    <th className="text-left px-3 py-1.5">Pattern</th>
                    <th className="text-right px-3 py-1.5">Instances</th>
                    <th className="text-right px-3 py-1.5">Total errors</th>
                    <th className="text-left px-3 py-1.5">Errors / fragment</th>
                    <th className="text-left px-3 py-1.5">2+ slot n</th>
                  </tr>
                </thead>
                <tbody>
                  {report.fragments.length === 0 ? (
                    <tr>
                      <td className="px-3 py-2 text-text-muted" colSpan={5}>
                        No fragment cohorts.
                      </td>
                    </tr>
                  ) : (
                    report.fragments.map((cohort, i) => (
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
                Single-call sittings
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-text-muted font-medium border-b border-footer-border">
                    <th className="text-left px-3 py-1.5">Method</th>
                    <th className="text-right px-3 py-1.5">Sittings</th>
                  </tr>
                </thead>
                <tbody>
                  {report.single_call_sittings.length === 0 ? (
                    <tr>
                      <td className="px-3 py-2 text-text-muted" colSpan={2}>
                        No single-call sittings.
                      </td>
                    </tr>
                  ) : (
                    report.single_call_sittings.map((entry) => (
                      <tr key={entry.method} className="border-b border-footer-border last:border-0">
                        <td className="px-3 py-1.5 font-mono text-text-primary">{entry.method}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{entry.sitting_count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="border border-footer-border rounded overflow-x-auto">
              <div className="px-4 py-2 text-[12px] font-semibold text-text-primary border-b border-footer-border">
                Bigrams
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-text-muted font-medium border-b border-footer-border">
                    <th className="text-left px-3 py-1.5">From</th>
                    <th className="text-left px-3 py-1.5">To</th>
                    <th className="text-right px-3 py-1.5">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {report.bigrams.length === 0 ? (
                    <tr>
                      <td className="px-3 py-2 text-text-muted" colSpan={3}>
                        No bigrams.
                      </td>
                    </tr>
                  ) : (
                    report.bigrams.map((entry, i) => (
                      <tr key={i} className="border-b border-footer-border last:border-0">
                        <td className="px-3 py-1.5 font-mono text-text-primary">{entry.from}</td>
                        <td className="px-3 py-1.5 font-mono text-text-primary">{entry.to}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{entry.count}</td>
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
                  {report.errors.length === 0 ? (
                    <tr>
                      <td className="px-3 py-2 text-text-muted" colSpan={9}>
                        No error cohorts.
                      </td>
                    </tr>
                  ) : (
                    report.errors.map((cohort, i) => <ErrorRow key={i} cohort={cohort} index={i} />)
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
                  {report.arg_shapes.length === 0 ? (
                    <tr>
                      <td className="px-3 py-2 text-text-muted" colSpan={5}>
                        No argument-shape failures.
                      </td>
                    </tr>
                  ) : (
                    report.arg_shapes.map((cohort, i) => (
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
                    <th className="text-left px-3 py-1.5">Agents</th>
                    <th className="text-right px-3 py-1.5">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {report.tool_counts.length === 0 ? (
                    <tr>
                      <td className="px-3 py-2 text-text-muted" colSpan={4}>
                        No tool calls.
                      </td>
                    </tr>
                  ) : (
                    report.tool_counts.map((entry) => (
                      <tr key={entry.method} className="border-b border-footer-border last:border-0">
                        <td className="px-3 py-1.5 font-mono text-text-primary">{entry.method}</td>
                        <td className="px-3 py-1.5 text-text-muted">{entry.inferred_tier}</td>
                        <td
                          className="px-3 py-1.5 text-text-muted"
                          title={entry.agents.map((a) => a.agent_id).join(", ")}
                        >
                          {entry.agents.map((a) => a.agent_display_name).join(", ")}
                        </td>
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
  );
}
