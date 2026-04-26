import { useEffect, useState, useCallback } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
interface FragmentFileInfo {
  filename: string;
  sizeBytes: number;
  content: string;
  hasEmbeddedHeading: boolean;
  sectionHeading: string | null;
}

interface OverlayDocInfo {
  skeleton: { filename: string; content: string; sectionRefs: string[] } | null;
  sections: Array<{ filename: string; content: string; isOrphaned: boolean }>;
  health: "ok" | "corrupt_missing_overlay_skeleton" | "corrupt_skeleton";
  issues: string[];
}

interface SessionStateResponse {
  fragments: Record<string, FragmentFileInfo[]>;
  docs: Record<string, OverlayDocInfo>;
  summary: {
    totalFragmentFiles: number;
    totalOverlayDocs: number;
    totalOverlaySections: number;
    orphanedSections: number;
    corruptOverlayDocs: number;
    missingOverlaySkeletonDocs: number;
  };
}

function truncateLines(text: string, maxLines: number, maxChars: number): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  const truncated = lines.length > maxLines;
  const result = lines
    .slice(0, maxLines)
    .map((line) => (line.length > maxChars ? line.slice(0, maxChars) + "…" : line))
    .join("\n");
  return { text: result, truncated };
}

export function SessionInspectorPage() {
  const [data, setData] = useState<SessionStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoPoll, setAutoPoll] = useState(false);
  const [expandedFragments, setExpandedFragments] = useState(true);
  const [expandedDocs, setExpandedDocs] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const response = await apiClient.getSessionState();
      setData(response);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoPoll) return;
    const timer = setInterval(() => {
      fetchData();
    }, 2000);
    return () => clearInterval(timer);
  }, [autoPoll, fetchData]);

  const summary = data?.summary;
  const isEmpty =
    summary &&
    summary.totalFragmentFiles === 0 &&
    summary.totalOverlayDocs === 0;

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Session Inspector" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        {/* Controls */}
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => { setLoading(true); fetchData(); }}
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:opacity-90"
          >
            Refresh
          </button>
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={autoPoll}
              onChange={(e) => setAutoPoll(e.target.checked)}
            />
            Auto-poll (2s)
          </label>
        </div>

        {error && (
          <div className="text-xs text-red-600 mb-3 p-2 bg-red-50 rounded">{error}</div>
        )}

        {loading && !data && <p className="text-xs text-text-muted">Loading session state…</p>}

        {data && (
          <>
            {/* Summary bar */}
            <div className="text-xs text-text-muted mb-4 p-2 bg-[#f7f5f1] rounded">
              {isEmpty ? (
                <span>No active session files — all clean</span>
              ) : (
                <span>
                  {summary!.totalFragmentFiles} fragment files · {summary!.totalOverlayDocs} overlay docs
                  {summary!.corruptOverlayDocs > 0 && (
                    <span className="text-red-600 ml-1">
                      · ⚠ {summary!.corruptOverlayDocs} corrupt docs
                    </span>
                  )}
                  {summary!.missingOverlaySkeletonDocs > 0 && (
                    <span className="text-red-600 ml-1">
                      · ⚠ {summary!.missingOverlaySkeletonDocs} missing skeleton
                    </span>
                  )}
                  {summary!.orphanedSections > 0 && (
                    <span className="text-yellow-600 ml-1">
                      · ⚠ {summary!.orphanedSections} orphaned
                    </span>
                  )}
                </span>
              )}
            </div>

            {/* Raw Fragments */}
            <div className="mb-4 border border-[#eae7e2] rounded-lg overflow-hidden">
              <button
                onClick={() => setExpandedFragments(!expandedFragments)}
                className="w-full text-left px-4 py-2.5 text-xs font-semibold text-text-primary bg-[#faf8f5] border-b border-[#eae7e2] hover:bg-[#f5f2ed] transition-colors"
              >
                {expandedFragments ? "▾" : "▸"} Raw Fragments (sessions/fragments/)
              </button>
              {expandedFragments && (
                <div className="p-3">
                  {Object.keys(data.fragments).length === 0 ? (
                    <p className="text-xs text-text-muted">(empty)</p>
                  ) : (
                    Object.entries(data.fragments).map(([docPath, files]) => (
                      <div key={docPath} className="mb-3">
                        <div className="text-xs font-semibold text-text-secondary mb-1" style={{ fontFamily: "var(--font-mono)" }}>
                          {docPath}
                        </div>
                        {files.map((f) => (
                          <div key={f.filename} className="ml-4 mb-2">
                            {f.sectionHeading !== null && (
                              <div className="text-[11px] font-medium text-text-secondary ml-1 mb-0.5">
                                Section: {f.sectionHeading}
                              </div>
                            )}
                            <div className="text-[11px] text-text-muted flex items-center gap-2">
                              <span style={{ fontFamily: "var(--font-mono)" }}>{f.filename}</span>
                              <span>{f.sizeBytes}B</span>
                              {f.hasEmbeddedHeading && (
                                <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded">⚑ embedded heading</span>
                              )}
                            </div>
                            <div className="mt-1 bg-[#f7f5f1] border border-[#eae7e2] rounded p-1.5">
                              {(() => { const t = truncateLines(f.content, 15, 120); return (<>
                                <pre className="text-[11px] text-text-muted whitespace-pre-wrap" style={{ fontFamily: "var(--font-mono)" }}>
                                  {t.text}
                                </pre>
                                {t.truncated && <div className="text-[10px] text-text-muted mt-0.5 italic">… truncated</div>}
                              </>); })()}
                            </div>
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Canonical-Ready Overlay */}
            <div className="mb-4 border border-[#eae7e2] rounded-lg overflow-hidden">
              <button
                onClick={() => setExpandedDocs(!expandedDocs)}
                className="w-full text-left px-4 py-2.5 text-xs font-semibold text-text-primary bg-[#faf8f5] border-b border-[#eae7e2] hover:bg-[#f5f2ed] transition-colors"
              >
                {expandedDocs ? "▾" : "▸"} Canonical-Ready Overlay (sessions/sections/)
              </button>
              {expandedDocs && (
                <div className="p-3">
                  {Object.keys(data.docs).length === 0 ? (
                    <p className="text-xs text-text-muted">(empty)</p>
                  ) : (
                    Object.entries(data.docs).map(([docPath, info]) => (
                      <div key={docPath} className="mb-3">
                        <div className="text-xs font-semibold text-text-secondary mb-1 flex items-center gap-2" style={{ fontFamily: "var(--font-mono)" }}>
                          <span>{docPath}</span>
                          {info.health !== "ok" && (
                            <span
                              className="text-[10px] bg-red-100 text-red-700 px-1 rounded font-semibold"
                              style={{ fontFamily: "var(--font-ui)" }}
                            >
                              CORRUPT
                            </span>
                          )}
                        </div>
                        {info.issues.map((issue, idx) => (
                          <div key={idx} className="ml-4 text-[11px] text-red-700 mb-1">
                            {issue}
                          </div>
                        ))}
                        {info.skeleton && (
                          <div className="ml-4 mb-2">
                            <div className="text-[11px] text-text-muted mb-1">Skeleton: {info.skeleton.filename}</div>
                            <pre className="text-[11px] text-text-muted ml-2 whitespace-pre-wrap border-l-2 border-[#eae7e2] pl-2" style={{ fontFamily: "var(--font-mono)" }}>
                              {info.skeleton.content}
                            </pre>
                            {info.skeleton.sectionRefs.length > 0 && (
                              <div className="flex gap-1 flex-wrap mt-1 ml-2">
                                {info.skeleton.sectionRefs.map((ref) => (
                                  <span key={ref} className="text-[10px] bg-[#f0ede8] text-text-secondary px-1.5 py-0.5 rounded" style={{ fontFamily: "var(--font-mono)" }}>
                                    {ref}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {info.sections.map((s) => (
                          <div key={s.filename} className="ml-4 mb-2">
                            <div className="text-[11px] text-text-muted flex items-center gap-2">
                              <span style={{ fontFamily: "var(--font-mono)" }}>{s.filename}</span>
                              {s.isOrphaned && (
                                <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1 rounded font-semibold">⚠ ORPHANED</span>
                              )}
                            </div>
                            {(() => { const t = truncateLines(s.content, 15, 120); return (<>
                              <pre className="text-[11px] text-text-muted mt-1 ml-2 whitespace-pre-wrap" style={{ fontFamily: "var(--font-mono)" }}>
                                {t.text}
                              </pre>
                              {t.truncated && <div className="text-[10px] text-text-muted mt-0.5 ml-2 italic">… truncated</div>}
                            </>); })()}
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

          </>
        )}
      </div>
    </div>
  );
}
