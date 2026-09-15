import { useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type { ShareDiaryEntry } from "../types/shared";

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function ShareDiaryPage() {
  const [entries, setEntries] = useState<ShareDiaryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getShareDiary()
      .then((response) => {
        if (!cancelled) setEntries(response.entries);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col">
      <SharedPageHeader title="Share Diary" backTo="/" />
      <div className="p-4 font-ui max-w-[900px]">
        <p className="text-text-muted text-[13px] mb-4">
          Every share link you have minted. This is a history record, not a management
          console — links cannot be edited, revoked, or re-copied from here.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-status-red-light border border-status-red/25 text-status-red rounded text-[13px]">
            {error}
          </div>
        )}

        {entries === null && !error ? (
          <p className="text-text-muted text-[13px]">Loading...</p>
        ) : null}

        {entries !== null && entries.length === 0 ? (
          <p className="text-text-muted text-[13px]">You haven't shared anything yet.</p>
        ) : null}

        {entries !== null && entries.length > 0 ? (
          <div className="border border-card-border rounded-lg overflow-hidden bg-canvas-bg">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-section-hover border-b border-footer-border">
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Path</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Kind</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Access</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Created</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Expires</th>
                </tr>
              </thead>
              <tbody>
                {entries
                  .slice()
                  .sort((a, b) => b.created_at.localeCompare(a.created_at))
                  .map((entry) => (
                    <tr key={entry.id} className="border-b border-footer-border last:border-0">
                      <td className="px-3 py-2 font-mono text-[12px] text-text-primary">{entry.path}</td>
                      <td className="px-3 py-2 text-text-primary">{entry.kind}</td>
                      <td className="px-3 py-2 text-text-primary">{entry.action}</td>
                      <td className="px-3 py-2 text-text-primary">{formatTimestamp(entry.created_at)}</td>
                      <td className="px-3 py-2 text-text-primary">{formatTimestamp(entry.expires_at)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
