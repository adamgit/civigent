import { useEffect, useState } from "react";
import { apiClient } from "../services/api-client.js";
import type {
  DocDiagnosticsResponse,
  DiagHealthCheck,
  DiagSectionLayerInfo,
  DiagLayerStatus,
  DiagSummary,
  DiagRestoreProvenance,
} from "../services/api-client.js";

interface DocumentDiagnosticsProps {
  docPath: string;
  onClose: () => void;
}

function renderSummary(summary: DiagSummary) {
  const items = [
    { label: "Top-level entries", value: summary.top_level_entries },
    { label: "Recursive structural entries", value: summary.recursive_structural_entries },
    { label: "Recursive content sections", value: summary.recursive_content_sections },
    { label: "Recursive sub-skeleton parents", value: summary.recursive_subskeleton_parents },
    { label: "Recursive max depth", value: summary.recursive_max_depth },
  ];
  return (
    <div className="border border-gray-200 rounded p-3">
      <h3 className="text-sm font-semibold mb-2">Structure Summary</h3>
      <div className="space-y-1">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-3 text-[12px] font-mono">
            <span className="text-gray-600">{item.label}</span>
            <span>{item.value ?? "\u2014"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderRestoreProvenance(restore: DiagRestoreProvenance) {
  const formatSha = (value: string | null) => value ? value.slice(0, 12) : "\u2014";
  const mismatch =
    restore.recursive_content_match === false
      ? `Current-only: ${restore.current_only_heading_keys.join(", ") || "(none)"} | Target-only: ${restore.target_only_heading_keys.join(", ") || "(none)"}`
      : null;
  return (
    <div className="border border-gray-200 rounded p-3">
      <h3 className="text-sm font-semibold mb-2">Restore Provenance</h3>
      <div className="space-y-1 text-[12px] font-mono">
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-600">Current HEAD</span>
          <span>{formatSha(restore.current_head_sha)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-600">Last restore commit</span>
          <span>{formatSha(restore.last_restore_commit_sha)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-600">Restore target</span>
          <span>{formatSha(restore.last_restore_target_sha)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-600">Target top-level entries</span>
          <span>{restore.target_top_level_entries ?? "\u2014"}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-600">Target recursive sections</span>
          <span>{restore.target_recursive_content_sections ?? "\u2014"}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-600">Recursive match</span>
          <span className={
            restore.recursive_content_match === null
              ? "text-gray-500"
              : restore.recursive_content_match
                ? "text-green-600"
                : "text-red-600"
          }>
            {restore.recursive_content_match === null ? "\u2014" : restore.recursive_content_match ? "match" : "mismatch"}
          </span>
        </div>
        {mismatch && (
          <div className="text-[11px] text-red-600 pt-1 break-words">
            {mismatch}
          </div>
        )}
      </div>
    </div>
  );
}

function renderChecks(checks: DiagHealthCheck[]) {
  try {
    const grouped = checks.reduce<Record<string, DiagHealthCheck[]>>((acc, check) => {
      const key = check.category || "Other";
      if (!acc[key]) acc[key] = [];
      acc[key].push(check);
      return acc;
    }, {});
    return (
      <div className="h-full min-h-0 flex flex-col">
        <h3 className="text-sm font-semibold mb-2 shrink-0">Health Checks</h3>
        <div className="min-h-0 flex-1 overflow-y-auto space-y-3">
          {Object.entries(grouped).map(([category, categoryChecks]) => (
            <div key={category} className="border border-gray-200 rounded">
              <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-100">
                {category}
              </div>
              {categoryChecks.map((check, i) => (
                <div
                  key={`${category}-${check.name}`}
                  className={`flex items-start gap-2 px-3 py-1 text-[12px] font-mono ${i < categoryChecks.length - 1 ? "border-b border-gray-100" : ""}`}
                >
                  <span className={check.pass ? "text-green-600" : "text-red-600"}>
                    {check.pass ? "\u2713" : "\u2717"}
                  </span>
                  <span className="font-medium">{check.name}</span>
                  {check.detail && (
                    <span className="text-gray-500 ml-2">{check.detail}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
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

const WINNER_COLORS: Record<string, string> = {
  canonical: "bg-blue-100 text-blue-800",
  overlay: "bg-yellow-100 text-yellow-800",
  fragment: "bg-purple-100 text-purple-800",
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

function renderSectionRow(section: DiagSectionLayerInfo, index: number) {
  try {
    if (section.error && section.winner === "error") {
      return (
        <tr key={index} className="border-b border-gray-100">
          <td className="px-2 py-1 text-[11px] font-mono">{section.headingKey || section.sectionFile}</td>
          <td colSpan={5} className="px-2 py-1 text-red-600 text-[11px]">
            {section.error}
          </td>
        </tr>
      );
    }
    return (
      <tr key={index} className="border-b border-gray-100">
        <td className="px-2 py-1 text-[11px] font-mono whitespace-nowrap">
          <div>
            {section.headingKey || "(body holder)"}
            {section.isSubSkeleton ? (
              <span className="ml-1 inline-block px-1 py-0 rounded bg-purple-100 text-purple-700 text-[9px] font-semibold">sub-skeleton</span>
            ) : null}
          </div>
          <div className="text-gray-400 text-[10px]">{section.sectionFile}</div>
        </td>
        {renderLayerCell(section.canonical, section.winner === "canonical")}
        {renderLayerCell(section.overlay, section.winner === "overlay")}
        {renderLayerCell(section.fragment, section.winner === "fragment")}
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
      </tr>
    );
  } catch (e) {
    return (
      <tr key={index} className="border-b border-gray-100">
        <td className="px-2 py-1 text-[11px] font-mono">{section.sectionFile}</td>
        <td colSpan={5} className="px-2 py-1 text-red-600 text-[11px]">
          Render error: {e instanceof Error ? e.message : String(e)}
        </td>
      </tr>
    );
  }
}

function renderSectionTable(sections: DiagSectionLayerInfo[]) {
  try {
    return (
      <div className="h-full min-h-0 flex flex-col">
        <h3 className="text-sm font-semibold mb-2 shrink-0">Section Layers</h3>
        <div className="overflow-auto border border-gray-200 rounded min-h-0 flex-1">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-50 sticky top-0">
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">Section</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">Canonical</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">Session Overlay</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">Fragment (disk)</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">CRDT (live)</th>
                <th className="px-2 py-1.5 text-left text-[11px] font-semibold text-gray-600">Winner</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((section, i) => renderSectionRow(section, i))}
              {sections.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-4 text-center text-gray-400 text-sm">
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
      <div className="relative bg-white rounded-lg shadow-xl max-w-[96vw] w-[1450px] h-[90vh] p-6 flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-700 text-lg leading-none"
        >
          &times;
        </button>
        <h2 className="text-lg font-semibold mb-4 shrink-0">Diagnostics: {docPath}</h2>

        {!data && !error && (
          <p className="text-gray-500 text-sm">Loading diagnostics...</p>
        )}

        {error && (
          <div className="text-red-600 text-sm">
            Failed to load diagnostics: {error}
          </div>
        )}

        {data && (
          <div className="grid grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)] gap-4 min-h-0 flex-1">
            <div className="min-h-0 flex flex-col gap-4">
              {renderSummary(data.summary)}
              {renderRestoreProvenance(data.restore_provenance)}
              <div className="min-h-0 flex-1">
                {renderChecks(data.checks)}
              </div>
            </div>
            {renderSectionTable(data.sections)}
          </div>
        )}
      </div>
    </div>
  );
}
