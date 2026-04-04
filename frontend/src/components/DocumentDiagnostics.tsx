import { useEffect, useState } from "react";
import { apiClient } from "../services/api-client.js";
import type {
  DocDiagnosticsResponse,
  DiagHealthCheck,
  DiagSectionLayerInfo,
  DiagLayerStatus,
} from "../services/api-client.js";

interface DocumentDiagnosticsProps {
  docPath: string;
  onClose: () => void;
}

function renderChecks(checks: DiagHealthCheck[]) {
  try {
    return (
      <div className="mb-6">
        <h3 className="text-sm font-semibold mb-2">Health Checks</h3>
        <div className="border border-gray-200 rounded">
          {checks.map((check, i) => (
            <div
              key={check.name}
              className={`flex items-start gap-2 px-3 py-1 text-[12px] font-mono ${i < checks.length - 1 ? "border-b border-gray-100" : ""}`}
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
      </div>
    );
  } catch (e) {
    return (
      <div className="text-red-600 text-sm mb-6">
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
      <div>
        <h3 className="text-sm font-semibold mb-2">Section Layers</h3>
        <div className="overflow-x-auto border border-gray-200 rounded">
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
      <div className="relative bg-white rounded-lg shadow-xl max-w-[95vw] max-h-[90vh] w-[1100px] overflow-y-auto p-6">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-700 text-lg leading-none"
        >
          &times;
        </button>
        <h2 className="text-lg font-semibold mb-4">Diagnostics: {docPath}</h2>

        {!data && !error && (
          <p className="text-gray-500 text-sm">Loading diagnostics...</p>
        )}

        {error && (
          <div className="text-red-600 text-sm">
            Failed to load diagnostics: {error}
          </div>
        )}

        {data && (
          <>
            {renderChecks(data.checks)}
            {renderSectionTable(data.sections)}
          </>
        )}
      </div>
    </div>
  );
}
