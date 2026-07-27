import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type { RunAdminContentIntegrityScanResponse } from "../types/shared.js";

function docsHref(docPath: string): string {
  return `/docs${docPath.startsWith("/") ? docPath : `/${docPath}`}`;
}

export function ContentIntegrityPage() {
  const [result, setResult] = useState<RunAdminContentIntegrityScanResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const next = await apiClient.runAdminContentIntegrityScan();
      setResult(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, []);

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Content Integrity" backTo="/admin" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        <p className="text-[13px] text-text-muted mb-4 max-w-2xl leading-relaxed">
          Scans every canonical document with the same section-assembly path the document page uses.
          Nothing is written — results are computed in memory and discarded when you leave.
        </p>

        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            onClick={() => void runScan()}
            disabled={scanning}
            className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "Scan all documents"}
          </button>
          {result && !scanning ? (
            <span className="text-[11px] text-text-muted ml-2">
              Last scan: {result.scanned_count} docs in {result.duration_ms}ms
            </span>
          ) : null}
        </div>

        {error ? (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded text-[12px] font-mono whitespace-pre-wrap">
            {error}
          </div>
        ) : null}

        {scanning && !result ? (
          <p className="text-xs text-text-muted">Scanning canonical documents…</p>
        ) : null}

        {result ? (
          <>
            <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white mb-4">
              <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
                <div className="text-[13px] font-semibold text-text-primary">Summary</div>
              </div>
              <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border">
                <span className="text-[12px] font-medium text-text-muted w-40 shrink-0">Scanned</span>
                <span className="text-[13px] text-text-primary tabular-nums">{result.scanned_count}</span>
              </div>
              <div className="flex items-baseline gap-4 px-4 py-2 border-b border-footer-border">
                <span className="text-[12px] font-medium text-text-muted w-40 shrink-0">OK</span>
                <span className="text-[13px] text-green-700 font-medium tabular-nums">{result.ok_count}</span>
              </div>
              <div className="flex items-baseline gap-4 px-4 py-2">
                <span className="text-[12px] font-medium text-text-muted w-40 shrink-0">Failures</span>
                <span
                  className={`text-[13px] font-medium tabular-nums ${
                    result.failure_count > 0 ? "text-red-700" : "text-text-primary"
                  }`}
                >
                  {result.failure_count}
                </span>
              </div>
            </div>

            <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white">
              <div className="px-4 py-2.5 border-b border-footer-border bg-[#faf8f5]">
                <div className="text-[13px] font-semibold text-text-primary">Failures</div>
                <div className="text-[11px] text-text-muted">
                  Full error text including stack traces
                </div>
              </div>

              {result.failures.length === 0 ? (
                <div className="px-4 py-4 text-[12px] text-green-700">
                  No integrity failures found.
                </div>
              ) : (
                result.failures.map((failure) => (
                  <div
                    key={failure.doc_path}
                    className="px-4 py-3 border-b border-footer-border last:border-0 space-y-2"
                  >
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <Link
                        to={docsHref(failure.doc_path)}
                        className="text-[13px] font-mono text-accent hover:underline break-all"
                      >
                        {failure.doc_path}
                      </Link>
                      <span className="pill pill-red">error</span>
                    </div>
                    <pre className="m-0 rounded border border-red-200 bg-red-50 p-3 text-[11px] text-red-800 overflow-auto max-h-[40vh] whitespace-pre-wrap break-words font-mono">
                      {failure.error}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
