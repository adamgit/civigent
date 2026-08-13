import { useEffect, useState } from "react";
import { apiClient } from "../services/api-client.js";
import type { DocPath } from "../types/shared.js";
import type {
  DocDiagnosticsResponse,
  DiagHealthCheck,
  DiagSectionLayerInfo,
  DiagLayerStatus,
} from "../services/api-client.js";

interface DocumentDiagnosticsProps {
  docPath: DocPath;
  onClose: () => void;
}

/**
 * Aggregate the "structural corruption is present" signal into a single top-of-
 * panel red banner. Draws from BOTH check-level failures (duplicate paths,
 * duplicate siblings, logical loss, unreadable sections, sub-skeleton invalid
 * state) and section-level layer errors so an unreadable body doesn't hide
 * because its diagnostic check hasn't been wired in yet.
 */
function renderInvalidStructureBanner(data: DocDiagnosticsResponse) {
  const triggerCheckNames = new Set([
    "duplicate-heading-paths",
    "duplicate-sibling-headings",
    "duplicate-fragment-keys",
    "live-duplicate-heading-paths",
    "live-duplicate-sibling-headings",
    "live-topology-vs-canonical",
    "live-claim-set-orphans",
    "no-logical-loss-in-heading-map",
    "public-api-returns-every-physical-section",
    "recursive-all-sections-readable",
    "top-level-all-sections-readable",
    "top-level-all-sections-parseable",
    "recursive-structure-load",
    "top-level-skeleton-parse",
    "duplicate-section-files",
  ]);
  const failing = data.checks.filter((c) => !c.pass && triggerCheckNames.has(c.name));
  const anyLayerError = data.sections.some((s) => s.winner === "error" || s.canonical.error || s.crdt.error || s.proposal.error);
  const backendStates = data.backend_states ?? [];
  if (failing.length === 0 && !anyLayerError && backendStates.length === 0) return null;
  const failedNames = failing.map((c) => c.name);
  if (anyLayerError && !failedNames.includes("layer-inspection-error")) failedNames.push("layer-inspection-error");
  return (
    <div className="border-2 border-red-500 bg-red-50 rounded p-3">
      <h3 className="text-sm font-bold text-red-800">Invalid document structure detected</h3>
      <p className="text-[12px] text-red-800 mt-1">
        Normal document reads may hide sections or surface a materially different document than the physical files.
        Editing or publishing in this state can lose data.
      </p>
      <ul className="text-[11px] text-red-800 mt-2 list-disc pl-5 space-y-0.5">
        <li>Repair duplicate headings before editing or publishing.</li>
        <li>Investigate unreadable / errored sections in the layers panel below.</li>
        <li>Review the collision groups panel for the specific physical files involved.</li>
      </ul>
      {backendStates.length > 0 && (
        <div className="mt-3 border-t border-red-300 pt-2">
          <div className="text-[12px] font-semibold text-red-900 mb-1">Backend-reported invalid state</div>
          <ul className="text-[11px] text-red-900 space-y-1">
            {backendStates.map((state, i) => (
              <li key={`${state.kind}-${i}`}>
                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium mr-2 ${state.kind === "live" ? "bg-yellow-200 text-yellow-900" : "bg-red-200 text-red-900"}`}>
                  {state.kind === "live" ? "live (transient)" : `${state.kind} (durable)`}
                </span>
                <span>{state.message}</span>
                {state.details.length > 0 && (
                  <div className="ml-4 text-[10px] text-red-700 font-mono">{state.details.join("; ")}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-[11px] text-red-700 mt-2 font-mono">
        Failing signals: {failedNames.length > 0 ? failedNames.join(", ") : "(backend state only)"}
      </div>
    </div>
  );
}

function renderHealthStripRow(label: string, rowChecks: DiagHealthCheck[]) {
  const passed = rowChecks.filter((c) => c.pass);
  const failed = rowChecks.filter((c) => !c.pass);
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <span className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</span>
      <div className="min-w-0 flex-1 space-y-0.5">
        {passed.length > 0 && (
          <div className="text-[12px] font-mono text-green-600 break-words">
            {"\u2713"} {passed.map((c) => c.name).join(", ")}
          </div>
        )}
        {failed.length > 0 && (
          <div className="text-[12px] font-mono text-red-600 break-words">
            {"\u2717"} {failed.map((c) => (c.detail ? `${c.name} \u2014 ${c.detail}` : c.name)).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}

function renderChecks(checks: DiagHealthCheck[]) {
  try {
    const canonicalChecks = checks.filter((c) => c.category === "Canonical");
    const liveChecks = checks.filter((c) => c.category === "Live");
    const liveSessionCheck = liveChecks.find((c) => c.name === "live-crdt-session");
    const noLiveSession = liveSessionCheck?.detail === "no-session";
    return (
      <div className="border border-gray-200 rounded divide-y divide-gray-100">
        {renderHealthStripRow("Canonical", canonicalChecks)}
        {noLiveSession ? (
          <div className="flex items-start gap-3 px-3 py-2">
            <span className="w-20 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Live</span>
            <span className="text-[12px] text-gray-500">No live session \u2014 not checked</span>
          </div>
        ) : (
          renderHealthStripRow("Live", liveChecks)
        )}
      </div>
    );
  } catch (e) {
    return (
      <div className="text-red-600 text-sm">
        Failed to render health checks: {e instanceof Error ? e.message : String(e)}
      </div>
    );
  }
}

// The durable layers are Canonical, the inprogress proposal, and the live CRDT.
const WINNER_COLORS: Record<string, string> = {
  canonical: "bg-blue-100 text-blue-800",
  proposal: "bg-lime-100 text-lime-800",
  crdt: "bg-green-100 text-green-800",
  none: "bg-gray-100 text-gray-500",
  error: "bg-red-100 text-red-800",
};

function renderLayerCell(layer: DiagLayerStatus, isWinner: boolean) {
  const bg = isWinner ? "bg-green-50" : "";
  if (layer.error) {
    return (
      <td className={`px-2 py-1 bg-red-50 text-red-700 text-[11px] font-mono`}>
        {layer.error}
      </td>
    );
  }
  if (!layer.exists) {
    return (
      <td className={`px-2 py-1 bg-gray-50 text-gray-400 text-[11px] font-mono`}>
        &mdash;
      </td>
    );
  }
  return (
    <td className={`px-2 py-1 ${bg} text-[11px] font-mono`}>
      <div className="overflow-hidden text-ellipsis whitespace-nowrap max-w-[200px]">
        {layer.contentPreview}
      </div>
      <div className="text-gray-400 text-[10px]">({layer.byteLength} bytes)</div>
    </td>
  );
}

/**
 * Group addressable content rows by `headingKey` so a duplicate-heading-path
 * collision — where multiple physical section bodies land at the same address —
 * is visible as a single group.
 *
 * Sub-skeleton parent files are structural indexes, not independently readable
 * section bodies. A healthy parent-with-children has both a parent sub-skeleton
 * file and a body-holder row folded onto the same visible heading path; counting
 * both here creates a false collision. Keep those structural rows in the layer
 * table, but exclude them from the "normal app read hides a body" warning.
 *
 * `__crdt_only__::…` keys are synthesized when a CRDT fragment has no canonical
 * entry; those are never collisions with real heading paths.
 */
function collectCollisionGroups(sections: DiagSectionLayerInfo[]): DiagSectionLayerInfo[][] {
  const byKey = new Map<string, DiagSectionLayerInfo[]>();
  for (const s of sections) {
    if (s.isSubSkeleton) continue;
    if (s.headingKey.startsWith("__crdt_only__::")) continue;
    const list = byKey.get(s.headingKey);
    if (list) list.push(s);
    else byKey.set(s.headingKey, [s]);
  }
  const groups: DiagSectionLayerInfo[][] = [];
  for (const rows of byKey.values()) {
    if (rows.length >= 2) groups.push(rows);
  }
  return groups;
}

/**
 * With duplicate section files at the same heading path, normal app reads via a
 * heading-key map keep the LAST-seen entry (a naive `map.set` in insertion
 * order). That is the row a normal document read would surface; the earlier
 * rows are physically present but MASKED. Encoded here as the single point of
 * change so the "select vs mask" story stays consistent if the app's map
 * insertion policy changes.
 */
function collisionWinnerIndex(rows: DiagSectionLayerInfo[]): number {
  return rows.length - 1;
}

function renderCollisionGroups(sections: DiagSectionLayerInfo[]) {
  const groups = collectCollisionGroups(sections);
  if (groups.length === 0) return null;
  return (
    <div id="collision-groups" className="border border-red-300 bg-red-50 rounded p-3">
      <h3 className="text-sm font-semibold mb-2 text-red-800">Heading-path collisions ({groups.length})</h3>
      <p className="text-[12px] text-red-900 mb-2">
        Two sibling sections that carry the same heading text under the same parent cannot be uniquely
        addressed by a heading path — the app looks up sections by that path, so one section will hide
        another after refresh. Every physical file below is present on disk, but only one is reachable
        through a normal read.
      </p>
      <details className="mb-2 text-[11px] text-red-900">
        <summary className="cursor-pointer font-semibold">Safe repair choices</summary>
        <ul className="list-disc pl-5 mt-1 space-y-0.5">
          <li>Rename one of the duplicate headings so each has a unique path.</li>
          <li>Merge the two bodies into a single section (copy the hidden body's content into the visible one, then delete the extra file).</li>
          <li>Move one of them under a different parent so their paths differ.</li>
          <li>Recover the hidden body from git history (see the section file id below) before deleting.</li>
        </ul>
        <p className="mt-1 italic">Do not attempt to auto-repair from diagnostics — pick a target manually and edit outside the app if needed.</p>
      </details>
      <div className="space-y-3">
        {groups.map((rows) => {
          const winnerIdx = collisionWinnerIndex(rows);
          const headingLabel = rows[0].headingKey || "(before first heading)";
          return (
            <div key={rows[0].headingKey} className="border border-red-200 bg-white rounded overflow-hidden">
              <div className="px-2 py-1.5 bg-red-100 text-red-900 text-[11px] font-mono flex items-center justify-between">
                <span>{headingLabel}</span>
                <span className="text-[10px] font-semibold">{rows.length} physical rows</span>
              </div>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="px-2 py-1 text-left text-[10px] font-semibold text-gray-600">Fragment key</th>
                    <th className="px-2 py-1 text-left text-[10px] font-semibold text-gray-600">Section file</th>
                    <th className="px-2 py-1 text-left text-[10px] font-semibold text-gray-600">Layer winner</th>
                    <th className="px-2 py-1 text-left text-[10px] font-semibold text-gray-600">Body preview</th>
                    <th className="px-2 py-1 text-left text-[10px] font-semibold text-gray-600">App reads</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const preview = row.canonical.contentPreview ?? row.crdt.contentPreview ?? "—";
                    return (
                      <tr key={row.fragmentKey} className="border-t border-red-100">
                        <td className="px-2 py-1 text-[11px] font-mono text-gray-700">{row.fragmentKey}</td>
                        <td className="px-2 py-1 text-[11px] font-mono text-gray-700">{row.sectionFile || "—"}</td>
                        <td className="px-2 py-1 text-[11px] font-mono">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${WINNER_COLORS[row.winner] ?? "bg-gray-100 text-gray-600"}`}>
                            {row.winner}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-[11px] font-mono text-gray-700 max-w-[240px]">
                          <div className="overflow-hidden text-ellipsis whitespace-nowrap">{preview}</div>
                        </td>
                        <td className="px-2 py-1 text-[11px] font-mono">
                          {i === winnerIdx ? (
                            <span className="inline-block px-1.5 py-0.5 rounded bg-red-600 text-white text-[10px] font-semibold">selected</span>
                          ) : (
                            <span className="inline-block px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-[10px]">masked</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function renderSectionLabel(section: DiagSectionLayerInfo) {
  const liveDiffers = section.liveHeadingKey !== null && section.liveHeadingKey !== section.headingKey;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        <span className={liveDiffers ? "text-gray-400" : undefined}>{section.headingKey || "(body holder)"}</span>
        {section.isSubSkeleton ? (
          <span className="inline-block px-1 py-0 rounded bg-purple-100 text-purple-700 text-[9px] font-semibold">sub-skeleton</span>
        ) : null}
      </div>
      {liveDiffers ? (
        <div>
          <span>{section.liveHeadingKey || "(body holder)"}</span>
        </div>
      ) : null}
    </>
  );
}

function renderSectionRow(section: DiagSectionLayerInfo, index: number) {
  // The React key is `fragmentKey` (physical identity), not `headingKey`. If
  // two rows share `headingKey` (a duplicate-heading-paths corruption case),
  // both are preserved as distinct rows in the table — the identity below the
  // heading label makes the collision visible.
  const rowKey = section.fragmentKey || `idx-${index}`;
  try {
    if (section.error && section.winner === "error") {
      return [
        <tr key={`${rowKey}-section`} className="border-b border-gray-100 bg-gray-50">
          <td colSpan={5} className="px-2 py-1.5 text-[11px] font-mono whitespace-normal [overflow-wrap:anywhere]">
            {renderSectionLabel(section)}
            <div className="mt-0.5 text-gray-400 text-[10px]">
              {section.fragmentKey}
              {section.sectionFile ? <> · {section.sectionFile}</> : null}
            </div>
          </td>
        </tr>,
        <tr key={`${rowKey}-error`} className="border-b border-gray-100">
          <td className="px-2 py-1 bg-gray-50" />
          <td colSpan={4} className="px-2 py-1 text-red-600 text-[11px]">
            {section.error}
          </td>
        </tr>,
      ];
    }
    return [
      <tr key={`${rowKey}-section`} className="border-b border-gray-100 bg-gray-50">
        <td colSpan={5} className="px-2 py-1.5 text-[11px] font-mono whitespace-normal [overflow-wrap:anywhere]">
          {renderSectionLabel(section)}
          <div className="mt-0.5 text-gray-400 text-[10px]">
            {section.fragmentKey}
            {section.sectionFile ? <> · {section.sectionFile}</> : null}
          </div>
        </td>
      </tr>,
      <tr key={`${rowKey}-layers`} className="border-b border-gray-100">
        <td className="px-2 py-1 bg-gray-50" />
        {renderLayerCell(section.canonical, section.winner === "canonical")}
        {renderLayerCell(section.proposal, section.winner === "proposal")}
        {renderLayerCell(section.crdt, section.winner === "crdt")}
        <td className="px-2 py-1 text-[11px]">
          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${WINNER_COLORS[section.winner] ?? "bg-gray-100 text-gray-600"}`}>
            {section.winner}
          </span>
          {section.winner === "none" && section.gitHistoryExists === true ? (
            <div className="text-[9px] text-green-600 mt-0.5">exists in git history</div>
          ) : section.winner === "none" && section.gitHistoryExists === false ? (
            <div className="text-[9px] text-red-600 mt-0.5">never in git</div>
          ) : null}
        </td>
      </tr>,
    ];
  } catch (e) {
    return [
      <tr key={`${rowKey}-section`} className="border-b border-gray-100 bg-gray-50">
        <td colSpan={5} className="px-2 py-1.5 text-[11px] font-mono whitespace-normal [overflow-wrap:anywhere]">
          {section.sectionFile}
        </td>
      </tr>,
      <tr key={`${rowKey}-render-error`} className="border-b border-gray-100">
        <td className="px-2 py-1 bg-gray-50" />
        <td colSpan={4} className="px-2 py-1 text-red-600 text-[11px]">
          Render error: {e instanceof Error ? e.message : String(e)}
        </td>
      </tr>,
    ];
  }
}

function renderSectionTable(sections: DiagSectionLayerInfo[]) {
  try {
    return (
      <div>
        <h3 className="text-sm font-semibold mb-2">Section Layers</h3>
        <div className="overflow-x-auto border border-gray-200 rounded">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-50 sticky top-0">
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">Section</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">Canonical</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">Proposal (durable)</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">CRDT (live)</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">Winner</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((section, i) => renderSectionRow(section, i))}
              {sections.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-4 text-center text-gray-400 text-sm">
                    No sections found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  } catch (e) {
    return (
      <div className="text-red-600 text-sm">
        Failed to render section table: {e instanceof Error ? e.message : String(e)}
      </div>
    );
  }
}

export default function DocumentDiagnostics({ docPath, onClose }: DocumentDiagnosticsProps) {
  const [data, setData] = useState<DocDiagnosticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getDocDiagnostics(docPath)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [docPath]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl w-[calc(100vw-2rem)] max-w-none h-[90vh] p-6 flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-700 text-lg leading-none"
        >
          &times;
        </button>
        <h2 className="text-lg font-semibold mb-4 shrink-0">Diagnostics: {docPath}</h2>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {!data && !error && (
            <p className="text-gray-500 text-sm">Loading diagnostics...</p>
          )}

          {error && (
            <div className="text-red-600 text-sm">
              Failed to load diagnostics: {error}
            </div>
          )}

          {data && (
            <div className="flex flex-col gap-4">
              {renderInvalidStructureBanner(data)}
              {renderCollisionGroups(data.sections)}
              {renderChecks(data.checks)}
              {renderSectionTable(data.sections)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
