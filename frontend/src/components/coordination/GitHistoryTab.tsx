import { useCallback, useEffect, useState } from "react";
import { CommitRow, type GitLogEntry } from "../CommitRow";
import { apiClient } from "../../services/api-client";

export function GitHistoryTab() {
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [docPathFilter, setDocPathFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);

  const fetchCommits = useCallback(async (offset: number, docPath?: string) => {
    const entries = await apiClient.getGitLog({ limit: 30, offset, doc_path: docPath });
    if (entries.length < 30) setHasMore(false);
    return entries;
  }, []);

  useEffect(() => {
    setLoading(true);
    setHasMore(true);
    fetchCommits(0, activeFilter).then((entries) => {
      setCommits(entries);
    }).catch(() => {
      setCommits([]);
    }).finally(() => {
      setLoading(false);
    });
  }, [activeFilter, fetchCommits]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const entries = await fetchCommits(commits.length, activeFilter);
      setCommits((prev) => [...prev, ...entries]);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveFilter(docPathFilter.trim() || undefined);
  };

  return (
    <div>
      <form onSubmit={handleFilterSubmit} className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={docPathFilter}
          onChange={(e) => setDocPathFilter(e.target.value)}
          placeholder="Filter by document path..."
          className="text-xs px-3 py-1.5 border border-[#eae7e2] rounded bg-white flex-1"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        />
        {activeFilter && (
          <button
            type="button"
            onClick={() => { setDocPathFilter(""); setActiveFilter(undefined); }}
            className="text-xs px-2 py-1.5 text-text-muted hover:text-text-primary"
          >
            Clear
          </button>
        )}
      </form>

      {loading ? (
        <p className="text-xs text-text-muted">Loading commits...</p>
      ) : commits.length === 0 ? (
        <p className="text-xs text-text-muted">No commits found.</p>
      ) : (
        <>
          <div className="border border-[#eae7e2] rounded-lg overflow-hidden bg-white">
            {commits.map((entry) => (
              <CommitRow key={entry.sha} entry={entry} />
            ))}
          </div>
          {hasMore && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-3 text-xs px-4 py-1.5 bg-[#f7f5f1] rounded hover:bg-[#eae7e2] text-text-secondary"
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
