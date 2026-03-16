import { useCallback, useEffect, useState } from "react";
import { apiClient, type DocHistoryVersion } from "../services/api-client";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface DocumentHistoryProps {
  docPath: string;
  onRestored?: () => void;
}

export function DocumentHistory({ docPath, onRestored }: DocumentHistoryProps) {
  const [versions, setVersions] = useState<DocHistoryVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewSha, setPreviewSha] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
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
      return;
    }
    setPreviewSha(sha);
    setPreviewLoading(true);
    try {
      const res = await apiClient.getDocHistoryPreview(docPath, sha);
      setPreviewContent(res.content);
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
      const res = await apiClient.restoreDoc(docPath, sha);
      if (res.committed_sha) {
        setRestoreResult(`Restored to ${sha.slice(0, 8)}. New commit: ${res.committed_sha.slice(0, 8)}`);
        setConfirmSha(null);
        onRestored?.();
      } else if (res.proposal_id) {
        setRestoreResult(`Restore blocked. Proposal ${res.proposal_id} created for manual review.`);
        setConfirmSha(null);
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

  if (versions.length === 0) {
    return <div className="p-4 text-sm text-text-muted">No version history available.</div>;
  }

  return (
    <div className="overflow-y-auto max-h-[70vh]">
      {restoreResult && (
        <div className="px-4 py-2 text-xs bg-[#f0f7f4] text-[#1d5a66] border-b border-[#f5f2ed]">
          {restoreResult}
        </div>
      )}
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
                <pre className="text-xs bg-[#faf8f5] p-3 rounded overflow-auto max-h-[300px] whitespace-pre-wrap font-mono">
                  {previewContent}
                </pre>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
