import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { DocumentSearchField } from "../components/DocumentSearchField";
import { ContentPanel } from "../components/ContentPanel";
import { PageStatusBar } from "../components/PageStatusBar";
import { apiClient } from "../services/api-client";
import { listRecentDocs, rememberRecentDoc } from "../services/recent-docs";
import { stripLeadingSlashForRoute } from "../app/docsRouteUtils";
import { mergeKnownDocPaths, filterDocsByQuery } from "../services/known-docs-merge";

export function RecentDocsPage() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<string[]>(() => listRecentDocs());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([apiClient.getActivity(2000, 3650), apiClient.listProposals()])
      .then(([activityResponse, proposalsResponse]) => {
        if (cancelled) return;
        const merged = mergeKnownDocPaths(
          listRecentDocs(),
          activityResponse.items,
          proposalsResponse.proposals,
        );
        setDocs(merged);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const filteredDocs = useMemo(() => filterDocsByQuery(docs, query), [docs, query]);

  const openDoc = (docPath: string) => {
    const trimmed = docPath.trim();
    if (!trimmed) return;
    rememberRecentDoc(trimmed);
    navigate(`/docs/${stripLeadingSlashForRoute(trimmed)}`);
  };

  const handleDirectOpen = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    openDoc(query);
  };

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Recent Documents" backTo="/" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        {/* Search field */}
        <form onSubmit={handleDirectOpen} className="mb-4">
          <DocumentSearchField
            placeholder="Open by path... e.g. ops/runbook.md"
            value={query}
            onChange={setQuery}
          />
        </form>

        {loading && <p className="text-xs text-text-muted">Loading known documents...</p>}
        {error && <p className="text-error text-xs">{error}</p>}

        {!loading && !error && (
          <ContentPanel>
            <ContentPanel.Header>
              <div>
                <ContentPanel.Title>Recently opened & edited</ContentPanel.Title>
                <ContentPanel.Subtitle>Documents from your recent context, activity, and proposal history</ContentPanel.Subtitle>
              </div>
            </ContentPanel.Header>
            <ContentPanel.Body className="p-0">
              {filteredDocs.length === 0 ? (
                <div className="p-4 text-xs text-text-muted">No matching documents found.</div>
              ) : (
                filteredDocs.map((docPath) => (
                  <div
                    key={docPath}
                    className="flex items-center gap-3 border-b border-[#f5f2ed] hover:bg-[#faf8f5] last:border-b-0"
                    style={{ padding: "10px 16px" }}
                  >
                    <span className="text-[10.5px] text-[#b8b2a8] shrink-0 w-[60px] text-right">Viewed</span>
                    <div className="flex-1 min-w-0">
                      <Link
                        to={`/docs/${stripLeadingSlashForRoute(docPath)}`}
                        onClick={() => rememberRecentDoc(docPath)}
                        className="text-[13px] font-medium text-text-primary hover:text-[#1d5a66] cursor-pointer"
                      >
                        {docPath}
                      </Link>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Link
                        to={`/docs/${stripLeadingSlashForRoute(docPath)}/edit`}
                        onClick={() => rememberRecentDoc(docPath)}
                        className="btn-small"
                      >
                        Edit
                      </Link>
                      <Link
                        to={`/docs/${stripLeadingSlashForRoute(docPath)}/reconcile`}
                        onClick={() => rememberRecentDoc(docPath)}
                        className="btn-small"
                        style={{ borderColor: "var(--color-agent-border)", color: "var(--color-agent-text)" }}
                      >
                        Reconcile
                      </Link>
                      <button
                        onClick={() => openDoc(docPath)}
                        className="btn-primary"
                      >
                        Open
                      </button>
                    </div>
                  </div>
                ))
              )}
            </ContentPanel.Body>
          </ContentPanel>
        )}
      </div>
      <PageStatusBar items={["Recent", `${docs.length} known documents`]} />
    </div>
  );
}
