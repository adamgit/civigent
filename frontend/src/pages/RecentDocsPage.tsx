import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { DocumentSearchField } from "../components/DocumentSearchField";
import { ContentPanel } from "../components/ContentPanel";
import { PageStatusBar } from "../components/PageStatusBar";
import { apiClient } from "../services/api-client";
import { listRecentDocs, rememberRecentDoc } from "../services/recent-docs";

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeDocPath(input: string): string {
  return input.trim().replace(/^\/+/, "");
}

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
        const fromActivity = activityResponse.items.flatMap((item) =>
          item.sections.map((s) => s.doc_path),
        );
        const fromProposals = proposalsResponse.proposals.flatMap((proposal) =>
          proposal.sections.map((section) => section.doc_path),
        );
        const merged = uniquePreserveOrder([...listRecentDocs(), ...fromActivity, ...fromProposals]);
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

  const filteredDocs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return docs;
    return docs.filter((docPath) => docPath.toLowerCase().includes(normalized));
  }, [docs, query]);

  const openDoc = (docPath: string) => {
    const normalized = normalizeDocPath(docPath);
    if (!normalized) return;
    rememberRecentDoc(normalized);
    navigate(`/docs/${normalized}`);
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
        {error && <p className="text-xs text-red-600">{error}</p>}

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
                        to={`/docs/${docPath}`}
                        onClick={() => rememberRecentDoc(docPath)}
                        className="text-[13px] font-medium text-text-primary hover:text-[#1d5a66] cursor-pointer"
                      >
                        {docPath}
                      </Link>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Link
                        to={`/docs/${docPath}/edit`}
                        onClick={() => rememberRecentDoc(docPath)}
                        className="text-[11px] px-2.5 py-1 rounded border border-[#eae7e2] bg-white text-text-secondary hover:bg-[#faf8f5]"
                      >
                        Edit
                      </Link>
                      <Link
                        to={`/docs/${docPath}/reconcile`}
                        onClick={() => rememberRecentDoc(docPath)}
                        className="text-[11px] px-2.5 py-1 rounded border border-[#c9b8e8] bg-white text-[#6b4fa0] hover:bg-[#faf8f5]"
                      >
                        Reconcile
                      </Link>
                      <button
                        onClick={() => openDoc(docPath)}
                        className="text-[11px] px-2.5 py-1 rounded text-white"
                        style={{ background: "#2d7a8a", border: "none", cursor: "pointer" }}
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
