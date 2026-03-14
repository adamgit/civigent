import { useCallback, useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { CommitRow, type GitLogEntry } from "../components/CommitRow";
import { apiClient } from "../services/api-client";

export function GitHistoryPage() {
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

  const clearFilter = () => {
    setDocPathFilter("");
    setActiveFilter(undefined);
  };

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Git History" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        {/* Filter bar */}
        <form onSubmit={handleFilterSubmit} className="flex items-center gap-2 mb-4">
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
              onClick={clearFilter}
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
              <div className="px-4 py-2.5 border-b border-[#f0ede8] bg-[#faf8f5]">
                <div className="text-[13px] font-semibold text-text-primary">Recent Commits</div>
                <div className="text-[11px] text-text-muted">Version history from the commit pipeline</div>
              </div>
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

        {/* Status bar */}
        <div
          className="mt-4 flex items-center gap-1 text-text-muted"
          style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10.5px" }}
        >
          <span>History</span>
          <span style={{ margin: "0 6px", color: "#d0ccc4" }}>&middot;</span>
          <span>{commits.length} commits shown</span>
          {commits.length > 0 && (
            <>
              <span style={{ margin: "0 6px", color: "#d0ccc4" }}>&middot;</span>
              <span>Latest: {commits[0].sha.slice(0, 8)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
