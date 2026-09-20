import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import { copyTextToClipboard } from "../utils/copy-text";
import type {
  McpLogErrorCohort,
  McpLogReadPatternKind,
  McpLogWriteOutcomeKind,
  RunAdminMcpLogAnalysisResponse,
} from "../types/shared.js";

type OutcomeDetail = {
  title: string;
  tools: string;
  notes: string[];
};

const WRITE_DETAILS: Record<McpLogWriteOutcomeKind, OutcomeDetail> = {
  wrote_sections_published: {
    title: "Wrote sections, then published",
    tools: "write_proposal_section | create_proposal(sections) → publish_proposal",
    notes: [
      "A successful publish. An empty proposal cannot be published, so the text was written in this cycle or in an earlier session.",
      "create_proposal with a non-empty sections array counts as a write. Failed publish_proposal calls do not close the cycle.",
      "Each count is one proposal cycle, cut at a successful publish or withdraw. Sessions that used only one tool are counted separately.",
    ],
  },
  structural_only_published: {
    title: "Only structural changes, then published",
    tools:
      "create_section | delete_section | move_section | reorder_section | rename_section | delete_document | rename_document → publish_proposal",
    notes: [
      "They published after structural work only. write_proposal_section was not in the cycle.",
      "Useful for spotting agents that reorganize the tree without writing section bodies.",
    ],
  },
  withdrew: {
    title: "Withdrew the proposal",
    tools: "withdraw_proposal",
    notes: [
      "Any cycle that successfully called withdraw_proposal is counted here.",
      "Withdraw wins over publish. If the same cycle also wrote or published, it still lands in this row.",
    ],
  },
  never_closed: {
    title: "Opened a proposal and never published or withdrew",
    tools: "create_proposal",
    notes: [
      "The cycle has create_proposal and then no successful publish_proposal or withdraw_proposal.",
      "The session ended with the proposal still open: abandoned, interrupted, or left for later.",
    ],
  },
};

const READ_DETAILS: Record<McpLogReadPatternKind, OutcomeDetail> = {
  listed_documents_then_read_whole: {
    title: "Listed documents, then read a whole document",
    tools: "list_documents → read_doc",
    notes: [
      "Inventory, then a whole-document read. read_doc pulls every section.",
      "A write cycle in the same stretch is classified as a write outcome instead. First matching read pattern wins.",
    ],
  },
  listed_sections_then_read_section: {
    title: "Listed sections, then read a section",
    tools: "list_sections → read_published_section",
    notes: [
      "The intended read path: heading inventory, then one published section.",
      "If they also listed documents and called read_doc, that pair wins and they would not appear here.",
    ],
  },
  searched_then_read_whole: {
    title: "Searched, then read a whole document",
    tools: "search_text → read_doc",
    notes: [
      "They searched, then pulled an entire document instead of the matching section.",
      "This row loses to list_documents → read_doc and to list_sections → read_published_section if those pairs are also present.",
    ],
  },
  searched_then_read_section: {
    title: "Searched, then read a section",
    tools: "search_text → read_published_section",
    notes: [
      "Search, then a section read. Closer to the intended path than search-then-read_doc.",
      "Only used when they did not also match a list-then-read pair, which are checked first.",
    ],
  },
  read_whole_document: {
    title: "Read a whole document",
    tools: "read_doc",
    notes: [
      "A whole-document read without list_documents or search_text in the same stretch.",
      "They went straight to a document. read_doc is the blunt substitute for reading one section.",
    ],
  },
  read_section: {
    title: "Read a section",
    tools: "read_published_section",
    notes: [
      "A section read without a winning list or search pair in the same stretch.",
      "They already knew the heading, or they skipped inventory and search.",
    ],
  },
};

const WRITE_LABELS: Record<McpLogWriteOutcomeKind, string> = {
  wrote_sections_published: WRITE_DETAILS.wrote_sections_published.title,
  structural_only_published: WRITE_DETAILS.structural_only_published.title,
  withdrew: WRITE_DETAILS.withdrew.title,
  never_closed: WRITE_DETAILS.never_closed.title,
};

const READ_LABELS: Record<McpLogReadPatternKind, string> = {
  listed_documents_then_read_whole: READ_DETAILS.listed_documents_then_read_whole.title,
  listed_sections_then_read_section: READ_DETAILS.listed_sections_then_read_section.title,
  searched_then_read_whole: READ_DETAILS.searched_then_read_whole.title,
  searched_then_read_section: READ_DETAILS.searched_then_read_section.title,
  read_whole_document: READ_DETAILS.read_whole_document.title,
  read_section: READ_DETAILS.read_section.title,
};

function CountBar({ count, total }: { count: number; total: number }) {
  const pct = total <= 0 ? 0 : Math.max(count > 0 ? 2 : 0, Math.round((count / total) * 100));
  return (
    <div className="flex items-center gap-2 shrink-0">
      <div className="h-2 w-16 rounded-sm bg-footer-border overflow-hidden">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[13px] text-text-primary tabular-nums min-w-[2rem] text-right">{count}</span>
    </div>
  );
}

function rangeSet(from: number, to: number): Set<number> {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const next = new Set<number>();
  for (let i = lo; i <= hi; i++) next.add(i);
  return next;
}

function selectedOrAll<T>(rows: readonly T[], selected: Set<number>): T[] {
  if (selected.size === 0) return [...rows];
  return rows.filter((_, index) => selected.has(index));
}

function copyEnvelope<T>(
  rowType: string,
  about: string,
  rows: readonly T[],
  selected: Set<number>,
): { row_type: string; about: string; subset: boolean; rows: T[] } {
  return {
    row_type: rowType,
    about,
    subset: selected.size > 0,
    rows: selectedOrAll(rows, selected),
  };
}

function rowTone(selected: boolean): string {
  return selected ? "bg-accent-light" : "hover:bg-section-hover";
}

function CopyAsJsonButton({ getValue }: { getValue: () => unknown }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary shrink-0"
      style={{ padding: "3px 10px", fontSize: 12 }}
      onClick={() => {
        void (async () => {
          const didCopy = await copyTextToClipboard(JSON.stringify(getValue(), null, 2));
          if (!didCopy) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })();
      }}
    >
      {copied ? "copied" : "copy as JSON"}
    </button>
  );
}

function useDragRowSelection(rowCount: number, rowsKey: unknown) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    setSelected(new Set());
  }, [rowsKey]);

  useEffect(() => {
    return () => {
      stopDrag.current?.();
    };
  }, []);

  const beginSelect = useCallback(
    (event: ReactPointerEvent, index: number) => {
      if (event.button !== 0) return;
      const from =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      if (from?.closest("button, a")) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      const root = rootRef.current;
      setSelected(new Set([index]));

      const indexAt = (clientX: number, clientY: number): number | null => {
        if (!root) return null;
        const el = document.elementFromPoint(clientX, clientY);
        if (!(el instanceof Element) || !root.contains(el)) return null;
        const row = el.closest("[data-row-index]");
        if (!(row instanceof HTMLElement) || !root.contains(row)) return null;
        const next = Number(row.dataset.rowIndex);
        if (!Number.isInteger(next) || next < 0 || next >= rowCount) return null;
        return next;
      };

      stopDrag.current?.();
      const onMove = (moveEvent: PointerEvent) => {
        const next = indexAt(moveEvent.clientX, moveEvent.clientY);
        if (next == null) return;
        setSelected(rangeSet(index, next));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        stopDrag.current = null;
      };
      stopDrag.current = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [rowCount],
  );

  return { rootRef, selected, beginSelect };
}

function CountRow({
  index,
  selected,
  onPointerDown,
  label,
  count,
  total,
  mono,
  onDetails,
}: {
  index: number;
  selected: boolean;
  onPointerDown: (event: ReactPointerEvent, index: number) => void;
  label: string;
  count: number;
  total: number;
  mono?: boolean;
  onDetails?: () => void;
}) {
  return (
    <div
      data-row-index={index}
      onPointerDown={(event) => onPointerDown(event, index)}
      className={`flex items-center gap-3 px-4 py-2 border-b border-footer-border last:border-0 ${rowTone(selected)}`}
    >
      <CountBar count={count} total={total} />
      <span className={`text-[13px] text-text-primary min-w-0 flex-1 ${mono ? "font-mono" : ""}`}>{label}</span>
      {onDetails ? (
        <button
          type="button"
          className="btn-secondary shrink-0"
          style={{ padding: "3px 10px", fontSize: 12 }}
          onClick={onDetails}
        >
          Details
        </button>
      ) : null}
    </div>
  );
}

function OutcomeDetailDialog({
  detail,
  onClose,
}: {
  detail: OutcomeDetail;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40 border-none cursor-pointer p-0"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-outcome-detail-title"
        className="relative bg-canvas-bg border border-card-border rounded-lg shadow-xl max-w-[95vw] w-[440px] p-5 font-ui"
      >
        <h2
          id="mcp-outcome-detail-title"
          className="font-mono text-[13px] font-semibold text-text-primary leading-snug break-words mb-3"
        >
          {detail.tools}
        </h2>
        <div className="flex flex-col gap-2">
          {detail.notes.map((note) => (
            <p key={note} className="text-[13px] text-text-primary m-0">
              {note}
            </p>
          ))}
        </div>
        <div className="flex justify-end mt-4">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

const SUMMARY_LINK_STYLE = {
  color: "var(--color-accent-text)",
  textDecoration: "underline",
  textUnderlineOffset: "2px",
} as const;

function Card({
  id,
  title,
  subtitle,
  className = "",
  headerAction,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  className?: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className={`border border-card-border rounded-lg overflow-hidden bg-canvas-bg scroll-mt-4 ${className}`}
    >
      <div className="px-4 py-2.5 border-b border-footer-border bg-section-hover flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-text-primary">{title}</div>
          {subtitle ? <div className="text-[11px] text-text-muted mt-0.5">{subtitle}</div> : null}
        </div>
        {headerAction}
      </div>
      {children}
    </div>
  );
}

function CopyableCard<T>({
  id,
  title,
  subtitle,
  rowType,
  about,
  rows,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  rowType: string;
  about: string;
  rows: readonly T[];
  children: (sel: {
    selected: Set<number>;
    beginSelect: (event: ReactPointerEvent, index: number) => void;
  }) => ReactNode;
}) {
  const { rootRef, selected, beginSelect } = useDragRowSelection(rows.length, rows);
  return (
    <Card
      id={id}
      title={title}
      subtitle={subtitle}
      headerAction={<CopyAsJsonButton getValue={() => copyEnvelope(rowType, about, rows, selected)} />}
    >
      <div ref={rootRef} className="select-none">
        {children({ selected, beginSelect })}
      </div>
    </Card>
  );
}

function ErrorRow({
  cohort,
  index,
  selected,
  onPointerDown,
}: {
  cohort: McpLogErrorCohort;
  index: number;
  selected: boolean;
  onPointerDown: (event: ReactPointerEvent, index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr
        data-row-index={index}
        onPointerDown={(event) => onPointerDown(event, index)}
        className={`border-b border-footer-border last:border-0 ${rowTone(selected)}`}
      >
        <td className="px-4 py-2 font-mono text-[12px] text-text-primary">
          <button
            type="button"
            className="border-none bg-transparent p-0 mr-1 text-text-muted cursor-pointer"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse agents" : "Expand agents"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "▾" : "▸"}
          </button>
          {cohort.method}
        </td>
        <td className="px-4 py-2 text-[12px] text-text-primary">{cohort.result}</td>
        <td className="px-4 py-2 font-mono text-[12px] text-text-muted break-words">{cohort.cause_template}</td>
        <td className="px-4 py-2 text-right tabular-nums text-[12px]">{cohort.instance_count}</td>
        <td className="px-4 py-2 text-right tabular-nums text-[12px]">{cohort.sittings_once}</td>
        <td className="px-4 py-2 text-right tabular-nums text-[12px]">{cohort.sittings_repeated}</td>
        <td className="px-4 py-2 text-right tabular-nums text-[12px] text-status-green">{cohort.recovered}</td>
        <td className="px-4 py-2 text-right tabular-nums text-[12px] text-status-yellow">{cohort.unresolved}</td>
        <td className="px-4 py-2 text-right tabular-nums text-[12px] text-status-red">{cohort.abandoned}</td>
      </tr>
      {expanded &&
        cohort.agents.map((agent) => (
          <tr
            key={`${index}-${agent.agent_id}`}
            data-row-index={index}
            onPointerDown={(event) => onPointerDown(event, index)}
            className={`border-b border-footer-border last:border-0 ${
              selected ? "bg-accent-light" : "bg-section-hover/40"
            }`}
          >
            <td className="px-4 py-1.5 pl-8 font-mono text-[12px] text-text-muted" colSpan={2} title={agent.agent_id}>
              {agent.agent_display_name}
            </td>
            <td className="px-4 py-1.5 text-[12px] text-text-muted">—</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-[12px]">{agent.instance_count}</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-[12px]">{agent.sittings_once}</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-[12px]">{agent.sittings_repeated}</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-[12px] text-status-green">{agent.recovered}</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-[12px] text-status-yellow">{agent.unresolved}</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-[12px] text-status-red">{agent.abandoned}</td>
          </tr>
        ))}
    </>
  );
}

function outcomeCount(
  rows: Array<{ kind: string; count: number }>,
  kind: string,
): number {
  return rows.find((row) => row.kind === kind)?.count ?? 0;
}

export function AgentMcpAnalysisPage() {
  const [report, setReport] = useState<RunAdminMcpLogAnalysisResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<OutcomeDetail | null>(null);

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

  const writeTotal = report?.write_outcomes.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const readTotal = report?.read_patterns.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const oneToolTotal = report?.one_tool_sessions.reduce((sum, row) => sum + row.session_count, 0) ?? 0;
  const abandonedTotal = report?.errors.reduce((sum, row) => sum + row.abandoned, 0) ?? 0;

  return (
    <div className="flex flex-col">
      <SharedPageHeader title="Agent MCP Analysis" backTo="/admin" />
      <div className="p-4 font-ui">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="min-w-0">
            {report ? (
              <>
                <div className="text-[11px] font-medium text-text-muted">Server log file</div>
                <code className="block truncate text-[12px] text-text-primary" title={report.log_file.path}>
                  {report.log_file.path}
                </code>
                <div className="mt-1 text-[11px] text-text-muted tabular-nums">
                  {report.log_file.size_bytes.toLocaleString()} bytes
                </div>
              </>
            ) : (
              <p className="text-[13px] text-text-muted">Reading flushed MCP sessions…</p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {report && !running ? (
              <span className="text-[11px] text-text-muted">
                {report.session_count.toLocaleString()} sessions in {report.duration_ms}ms
              </span>
            ) : null}
            {report?.log_file.exists ? (
              <a href="/api/admin/agent-activity/download" download className="btn-secondary no-underline">
                Download log
              </a>
            ) : null}
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

        {error ? (
          <div className="mb-4 p-3 bg-status-red-light border border-status-red/25 text-status-red rounded text-[12px] font-mono whitespace-pre-wrap">
            {error}
          </div>
        ) : null}

        {report ? (
          <div className="flex flex-col gap-4">
            <Card title="Summary">
              <div className="px-4 py-3 flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                  <div>
                    <div className="text-[22px] font-semibold tabular-nums text-text-primary leading-none">
                      {report.session_count.toLocaleString()}
                    </div>
                    <div className="text-[11px] text-text-muted mt-1">sessions</div>
                  </div>
                  <div>
                    <div className="text-[18px] font-semibold tabular-nums text-text-primary leading-none">
                      {outcomeCount(report.write_outcomes, "wrote_sections_published").toLocaleString()}
                    </div>
                    <div className="text-[11px] text-text-muted mt-1">wrote and published</div>
                  </div>
                  <div>
                    <div className="text-[18px] font-semibold tabular-nums text-status-red leading-none">
                      {abandonedTotal.toLocaleString()}
                    </div>
                    <div className="text-[11px] text-text-muted mt-1">abandoned errors</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] pt-2 border-t border-footer-border">
                  <a href="#mcp-write-outcomes" style={SUMMARY_LINK_STYLE}>
                    Write outcomes
                  </a>
                  <a href="#mcp-read-patterns" style={SUMMARY_LINK_STYLE}>
                    How they read
                  </a>
                  <a href="#mcp-errors" style={SUMMARY_LINK_STYLE}>
                    Errors
                  </a>
                  <a href="#mcp-arg-shapes" style={SUMMARY_LINK_STYLE}>
                    Argument-shape
                  </a>
                  <a href="#mcp-tool-counts" style={SUMMARY_LINK_STYLE}>
                    Tool counts
                  </a>
                  <a href="#mcp-one-tool-sessions" style={SUMMARY_LINK_STYLE}>
                    One-tool sessions
                  </a>
                </div>
              </div>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <CopyableCard
                id="mcp-write-outcomes"
                title="Write outcomes"
                subtitle="Proposal cycles cut at publish or withdraw."
                rowType="McpLogWriteOutcome"
                about="Proposal cycles cut at publish or withdraw. One-tool sessions are counted separately."
                rows={report.write_outcomes}
              >
                {({ selected, beginSelect }) =>
                  report.write_outcomes.map((row, index) => (
                    <CountRow
                      key={row.kind}
                      index={index}
                      selected={selected.has(index)}
                      onPointerDown={beginSelect}
                      label={WRITE_LABELS[row.kind]}
                      count={row.count}
                      total={writeTotal}
                      onDetails={() => setDetail(WRITE_DETAILS[row.kind])}
                    />
                  ))
                }
              </CopyableCard>

              <CopyableCard
                id="mcp-read-patterns"
                title="How they read"
                subtitle="Read-only stretches between proposal cycles."
                rowType="McpLogReadPattern"
                about="Read-only stretches between proposal cycles. First matching pair wins."
                rows={report.read_patterns}
              >
                {({ selected, beginSelect }) =>
                  report.read_patterns.map((row, index) => (
                    <CountRow
                      key={row.kind}
                      index={index}
                      selected={selected.has(index)}
                      onPointerDown={beginSelect}
                      label={READ_LABELS[row.kind]}
                      count={row.count}
                      total={readTotal}
                      onDetails={() => setDetail(READ_DETAILS[row.kind])}
                    />
                  ))
                }
              </CopyableCard>
            </div>

            <CopyableCard
              id="mcp-errors"
              title="Errors"
              subtitle="Expand a row to see which agents hit it."
              rowType="McpLogErrorCohort"
              about="Cohorts of failed or blocked tool calls, grouped by method + result + normalized cause. In the same sitting, later same-method ok = recovered; later same-method fail = unresolved; no later same-method call = abandoned."
              rows={report.errors}
            >
              {({ selected, beginSelect }) => (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-[11px] text-text-muted font-medium border-b border-footer-border">
                        <th className="text-left px-4 py-2">Method</th>
                        <th className="text-left px-4 py-2">Result</th>
                        <th className="text-left px-4 py-2">Cause</th>
                        <th className="text-right px-4 py-2">Instances</th>
                        <th className="text-right px-4 py-2">Once</th>
                        <th className="text-right px-4 py-2">Repeated</th>
                        <th className="text-right px-4 py-2">Recovered</th>
                        <th className="text-right px-4 py-2">Unresolved</th>
                        <th className="text-right px-4 py-2">Abandoned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.errors.length === 0 ? (
                        <tr>
                          <td className="px-4 py-3 text-[12px] text-text-muted" colSpan={9}>
                            No error cohorts.
                          </td>
                        </tr>
                      ) : (
                        report.errors.map((cohort, i) => (
                          <ErrorRow
                            key={i}
                            cohort={cohort}
                            index={i}
                            selected={selected.has(i)}
                            onPointerDown={beginSelect}
                          />
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CopyableCard>

            <CopyableCard
              id="mcp-arg-shapes"
              title="Argument-shape failures"
              rowType="McpLogArgShapeCohort"
              about="Refused or invalid-argument errors, grouped by method + normalized cause + doc path."
              rows={report.arg_shapes}
            >
              {({ selected, beginSelect }) => (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-[11px] text-text-muted font-medium border-b border-footer-border">
                        <th className="text-left px-4 py-2">Method</th>
                        <th className="text-left px-4 py-2">Cause</th>
                        <th className="text-left px-4 py-2">Doc path</th>
                        <th className="text-right px-4 py-2">Instances</th>
                        <th className="text-left px-4 py-2">Sample</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.arg_shapes.length === 0 ? (
                        <tr>
                          <td className="px-4 py-3 text-[12px] text-text-muted" colSpan={5}>
                            No argument-shape failures.
                          </td>
                        </tr>
                      ) : (
                        report.arg_shapes.map((cohort, i) => (
                          <tr
                            key={i}
                            data-row-index={i}
                            onPointerDown={(event) => beginSelect(event, i)}
                            className={`border-b border-footer-border last:border-0 ${rowTone(selected.has(i))}`}
                          >
                            <td className="px-4 py-2 font-mono text-[12px] text-text-primary">{cohort.method}</td>
                            <td className="px-4 py-2 font-mono text-[12px] text-text-muted break-words">
                              {cohort.cause_template}
                            </td>
                            <td className="px-4 py-2 font-mono text-[12px] text-text-muted break-all">
                              {cohort.doc_path ?? "—"}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums text-[12px]">{cohort.instance_count}</td>
                            <td className="px-4 py-2 font-mono text-[12px] text-text-muted break-words">
                              {cohort.sample_error_message}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CopyableCard>

            <CopyableCard
              id="mcp-tool-counts"
              title="Tool counts"
              subtitle="Tier is inferred from the tool name, not the MCP endpoint."
              rowType="McpLogToolCount"
              about="Tier is inferred from the tool name, not the MCP endpoint."
              rows={report.tool_counts}
            >
              {({ selected, beginSelect }) => (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-[11px] text-text-muted font-medium border-b border-footer-border">
                        <th className="text-left px-4 py-2">Method</th>
                        <th className="text-left px-4 py-2">Tier (inferred)</th>
                        <th className="text-left px-4 py-2">Agents</th>
                        <th className="text-right px-4 py-2">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.tool_counts.length === 0 ? (
                        <tr>
                          <td className="px-4 py-3 text-[12px] text-text-muted" colSpan={4}>
                            No tool calls.
                          </td>
                        </tr>
                      ) : (
                        report.tool_counts.map((entry, i) => (
                          <tr
                            key={entry.method}
                            data-row-index={i}
                            onPointerDown={(event) => beginSelect(event, i)}
                            className={`border-b border-footer-border last:border-0 ${rowTone(selected.has(i))}`}
                          >
                            <td className="px-4 py-2 font-mono text-[12px] text-text-primary">{entry.method}</td>
                            <td className="px-4 py-2 text-[12px] text-text-muted">{entry.inferred_tier}</td>
                            <td
                              className="px-4 py-2 text-[12px] text-text-muted"
                              title={entry.agents.map((agent) => agent.agent_id).join(", ")}
                            >
                              {entry.agents.map((agent) => agent.agent_display_name).join(", ")}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums text-[12px]">{entry.count}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </CopyableCard>

            <CopyableCard
              id="mcp-one-tool-sessions"
              title="Sessions that used only one tool"
              subtitle="An MCP session that connected, called only this tool, and disconnected."
              rowType="McpLogOneToolSession"
              about="An MCP session that connected, called only this tool, and disconnected."
              rows={report.one_tool_sessions}
            >
              {({ selected, beginSelect }) =>
                report.one_tool_sessions.length === 0 ? (
                  <div className="px-4 py-3 text-[12px] text-text-muted">No one-tool sessions.</div>
                ) : (
                  report.one_tool_sessions.map((row, index) => (
                    <CountRow
                      key={row.method}
                      index={index}
                      selected={selected.has(index)}
                      onPointerDown={beginSelect}
                      label={row.method}
                      count={row.session_count}
                      total={oneToolTotal}
                      mono
                    />
                  ))
                )
              }
            </CopyableCard>
          </div>
        ) : null}
      </div>
      {detail ? <OutcomeDetailDialog detail={detail} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}
