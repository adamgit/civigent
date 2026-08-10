import { useCallback, useEffect, useState } from "react";
import { apiClient, type DocHistoryVersion } from "../services/api-client";
import type { DocPath } from "../types/shared";
import { relativeTime } from "../utils/relativeTime";
import {
  describeUnpublishedHistoryRow,
  type UnpublishedHistoryRow,
} from "../models/unpublished-history";

interface DocumentHistoryProps {
  docPath: DocPath;
  onRestored?: () => void;
  /**
   * When the document has a bound `inprogress` live proposal, its unpublished
   * change-set is prepended as a grayed, non-restorable row above the committed
   * versions (FP16/FP17). `null`/absent renders no such row.
   */
  unpublishedRow?: UnpublishedHistoryRow | null;
}

export function DocumentHistory({ docPath, onRestored, unpublishedRow = null }: DocumentHistoryProps) {
  const [versions, setVersions] = useState<DocHistoryVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewSha, setPreviewSha] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewCorrupt, setPreviewCorrupt] = useState(false);
  const [previewMissingSections, setPreviewMissingSections] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [confirmSha, setConfirmSha] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient.getDocHistory(docPath, { limit: 50 }).then(
      (res) => { if (!cancelled) { setVersions(res.versions); setLoading(false); } },
      (err) => { if (!cancelled) { setError(err.message); setLoading(false); } },
    );
    return () => { cancelled = true; };
  }, [docPath]);

  const handlePreview = useCallback(async (sha: string) => {
    if (previewSha === sha) {
      setPreviewSha(null);
      setPreviewContent(null);
      setPreviewCorrupt(false);
      setPreviewMissingSections([]);
      return;
    }
    setPreviewSha(sha);
    setPreviewLoading(true);
    setPreviewCorrupt(false);
    setPreviewMissingSections([]);
    try {
      const res = await apiClient.getDocHistoryPreview(docPath, sha);
      setPreviewContent(res.content);
      setPreviewCorrupt(res.corrupt ?? false);
      setPreviewMissingSections(res.missingSections ?? []);
    } catch (err) {
      setPreviewContent(`Failed to load preview: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreviewLoading(false);
    }
  }, [docPath, previewSha]);

  const handleRestore = useCallback(async (sha: string) => {
    setRestoring(sha);
    setRestoreResult(null);
    try {
      // Restore publishes-or-aborts the live DocSession, then commits the target
      // version to canonical, returning the new commit SHA (api-client
      // DocRestoreResponse). There is no "blocked/proposal created" branch.
      const res = await apiClient.restoreDoc(docPath, sha);
      if (res.committed_sha) {
        setRestoreResult(`Restored to ${sha.slice(0, 8)}. New commit: ${res.committed_sha.slice(0, 8)}`);
        setConfirmSha(null);
        onRestored?.();
      }
    } catch (err) {
      setRestoreResult(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRestoring(null);
    }
  }, [docPath, onRestored]);

  if (loading) {
    return <div className="p-4 text-sm text-text-muted">Loading history...</div>;
  }

  if (error) {
    return <div className="p-4 text-sm text-red-600">{error}</div>;
  }

  // FP16/FP17: a grayed, non-restorable row for the document's uncommitted live
  // proposal. It carries no git SHA and offers no restore/preview — it is an
  // in-flight change-set, not a canonical version.
  const unpublishedRowElement = unpublishedRow ? (
    <div className="border-b border-[#f5f2ed] opacity-60" data-testid="unpublished-history-row">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-bold text-text-primary">Unpublished</span>
          <span className="text-[11px] text-text-muted italic">not yet committed</span>
        </div>
        <div className="text-[13px] text-text-primary mb-1">
          {describeUnpublishedHistoryRow(unpublishedRow)}
        </div>
        <div className="text-[11px] text-text-muted">
          Live draft — publish it from the shared-draft banner to add it to history.
        </div>
      </div>
    </div>
  ) : null;

  if (versions.length === 0) {
    return (
      <div className="overflow-y-auto max-h-[70vh]">
        {unpublishedRowElement}
        <div className="p-4 text-sm text-text-muted">No version history available.</div>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto max-h-[70vh]">
      {restoreResult && (
        <div className="px-4 py-2 text-xs bg-[#f0f7f4] text-[#1d5a66] border-b border-[#f5f2ed]">
          {restoreResult}
        </div>
      )}
      {unpublishedRowElement}
      {versions.map((v) => (
        <div key={v.sha} className="border-b border-[#f5f2ed]">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold text-text-primary">{v.author_name}</span>
              <span className="text-[11px] text-text-muted">{relativeTime(v.timestamp_iso)}</span>
            </div>
            <div className="text-[13px] text-text-primary truncate mb-1">{v.message}</div>
            <div className="text-[11px] text-text-muted flex items-center gap-2 mb-2">
              <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{v.sha.slice(0, 8)}</span>
              <span>{v.changed_files.length} files</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handlePreview(v.sha)}
                className="text-[11px] px-2 py-1 rounded bg-[#f5f2ed] hover:bg-[#ece8e1] text-text-primary"
              >
                {previewSha === v.sha ? "Hide preview" : "Preview"}
              </button>
              {confirmSha === v.sha ? (
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-text-muted">Restore to this version?</span>
                  <button
                    onClick={() => handleRestore(v.sha)}
                    disabled={restoring !== null}
                    className="text-[11px] px-2 py-1 rounded bg-[#e8f4f6] hover:bg-[#d5eaed] text-[#1d5a66] font-semibold disabled:opacity-50"
                  >
                    {restoring === v.sha ? "Restoring..." : "Confirm"}
                  </button>
                  <button
                    onClick={() => setConfirmSha(null)}
                    className="text-[11px] px-2 py-1 rounded bg-[#f5f2ed] hover:bg-[#ece8e1] text-text-muted"
                  >
                    Cancel
                  </button>
                </div>
              ) : (previewSha === v.sha && previewCorrupt) ? (
                <span
                  className="text-[11px] px-2 py-1 rounded bg-red-50 text-red-400 cursor-not-allowed"
                  title="Cannot restore — commit has missing sections that would reproduce corruption"
                >
                  Restore unavailable
                </span>
              ) : (
                <button
                  onClick={() => setConfirmSha(v.sha)}
                  disabled={restoring !== null}
                  className="text-[11px] px-2 py-1 rounded bg-[#f5f2ed] hover:bg-[#ece8e1] text-text-primary disabled:opacity-50"
                >
                  Restore
                </button>
              )}
            </div>
          </div>
          {previewSha === v.sha && (
            <div className="px-4 pb-3">
              {previewLoading ? (
                <div className="text-xs text-text-muted">Loading preview...</div>
              ) : (
                <>
                  {previewCorrupt && (
                    <div className="mb-2 p-2 rounded bg-red-50 border border-red-200 text-xs text-red-800">
                      <strong>Warning:</strong> this commit has {previewMissingSections.length} missing section(s) — content shown is incomplete. Restoring this version will reproduce the corruption.
                      <ul className="mt-1 ml-4 list-disc">
                        {previewMissingSections.map((s) => (
                          <li key={s} className="font-mono">{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <pre className="text-xs bg-[#faf8f5] p-3 rounded overflow-auto max-h-[300px] whitespace-pre-wrap font-mono">
                    {previewContent}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
