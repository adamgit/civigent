import { type FormEvent, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { DocumentSearchField } from "../components/DocumentSearchField";
import { ContentPanel } from "../components/ContentPanel";
import { PageStatusBar } from "../components/PageStatusBar";
import { DocumentsTreeNav } from "../components/DocumentsTreeNav";
import { rememberRecentDoc } from "../services/recent-docs";
import type { DocumentTreeEntry } from "../types/shared.js";
import type { AppLayoutOutletContext } from "../app/AppLayout";

function filterTree(entries: DocumentTreeEntry[], query: string): DocumentTreeEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return entries;
  const out: DocumentTreeEntry[] = [];
  for (const entry of entries) {
    const pathMatches = entry.path.toLowerCase().includes(normalized);
    if (entry.type === "file") {
      if (pathMatches) out.push(entry);
      continue;
    }
    const childEntries = Array.isArray(entry.children) ? filterTree(entry.children, query) : [];
    if (pathMatches || childEntries.length > 0) {
      out.push({ ...entry, children: childEntries });
    }
  }
  return out;
}

function countItems(entries: DocumentTreeEntry[]): { docs: number; folders: number } {
  let docs = 0;
  let folders = 0;
  for (const entry of entries) {
    if (entry.type === "file") {
      docs++;
    } else {
      folders++;
      if (entry.children) {
        const child = countItems(entry.children);
        docs += child.docs;
        folders += child.folders;
      }
    }
  }
  return { docs, folders };
}

export function DocsBrowserPage() {
  const { entries, treeLoading, treeSyncing, treeError, createDoc } = useOutletContext<AppLayoutOutletContext>();
  const [query, setQuery] = useState("");
  const [newDocPath, setNewDocPath] = useState("");
  const [creatingDoc, setCreatingDoc] = useState(false);
  const [newDocError, setNewDocError] = useState<string | null>(null);

  const handleNewDocSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newDocPath.trim();
    if (!trimmed || creatingDoc) return;
    setCreatingDoc(true);
    setNewDocError(null);
    createDoc(trimmed)
      .then(() => setNewDocPath(""))
      .catch((err) => setNewDocError(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreatingDoc(false));
  };

  const filteredEntries = useMemo(() => filterTree(entries, query), [entries, query]);
  const isEmpty = !treeLoading && !treeError && entries.length === 0;
  const counts = useMemo(() => countItems(entries), [entries]);

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Documents" backTo="/" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        {/* New document bar */}
        {!treeLoading && !isEmpty && (
          <form onSubmit={handleNewDocSubmit} className="flex items-center gap-2.5 mb-4">
            <input
              type="text"
              value={newDocPath}
              onChange={(e) => setNewDocPath(e.target.value)}
              placeholder="New document path, e.g. ops/runbook.md"
              disabled={creatingDoc}
              className="flex-1"
              style={{
                fontFamily: "'JetBrains Mono', var(--font-mono, monospace)",
                fontSize: 13,
                padding: "9px 12px",
                border: "1px solid #eae7e2",
                borderRadius: 7,
                background: "white",
              }}
            />
            <button
              type="submit"
              disabled={creatingDoc}
              style={{
                background: "#2d7a8a",
                color: "white",
                fontSize: 12,
                padding: "7px 14px",
                borderRadius: 6,
                border: "none",
                cursor: creatingDoc ? "wait" : "pointer",
              }}
            >
              {creatingDoc ? "Creating…" : "+ Create document"}
            </button>
          </form>
        )}
        {newDocError && <p className="text-xs text-red-600 mb-3">{newDocError}</p>}

        {/* Recent docs + Search/filter row */}
        {!isEmpty && (
          <div className="flex gap-3 mb-4 items-stretch">
            <Link
              to="/recent-docs"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                border: "1px solid #eae7e2",
                borderRadius: 7,
                padding: "8px 14px",
                background: "white",
                color: "#1d5a66",
                fontSize: 13,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontSize: 13, opacity: 0.5 }}>&#128337;</span> Recent
            </Link>
            <div className="flex-1">
              <DocumentSearchField
                placeholder="Filter documents..."
                value={query}
                onChange={setQuery}
              />
            </div>
          </div>
        )}

        {treeLoading && <p className="text-xs text-text-muted">Loading document tree...</p>}
        {!treeLoading && treeSyncing && <p className="text-xs text-text-muted">Syncing latest committed changes...</p>}
        {treeError && <p className="text-xs text-red-600">{treeError}</p>}

        {isEmpty ? (
          <div className="text-center mt-8">
            <p className="text-sm mb-4">No documents yet. Create your first document to get started.</p>
            <form onSubmit={handleNewDocSubmit} className="inline-flex gap-2 items-center flex-wrap justify-center">
              <input
                type="text"
                value={newDocPath}
                onChange={(e) => setNewDocPath(e.target.value)}
                placeholder="e.g. my-folder/my-document"
                autoFocus
                disabled={creatingDoc}
                style={{
                  width: "22rem",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13,
                  padding: "9px 12px",
                  border: "1px solid #eae7e2",
                  borderRadius: 7,
                }}
              />
              <button
                type="submit"
                disabled={creatingDoc}
                style={{
                  background: "#2d7a8a",
                  color: "white",
                  fontSize: 12,
                  padding: "7px 14px",
                  borderRadius: 6,
                  border: "none",
                  cursor: creatingDoc ? "wait" : "pointer",
                }}
              >
                {creatingDoc ? "Creating…" : "Create Document"}
              </button>
            </form>
          </div>
        ) : null}

        {!treeLoading && !treeError && !isEmpty && (
          <ContentPanel>
            <ContentPanel.Body className="p-0">
              <DocumentsTreeNav
                entries={filteredEntries}
                storageKey="ks_docs_page_tree_expanded"
                forceExpandAll={query.trim().length > 0}
                onDocumentOpen={rememberRecentDoc}
                onCreateDocumentInFolder={(folderPath) => {
                  const trimmedFolder = folderPath === "/" ? "" : folderPath.replace(/\/+$/, "");
                  setNewDocPath(trimmedFolder ? `${trimmedFolder}/` : "");
                }}
              />
            </ContentPanel.Body>
            <ContentPanel.Summary>
              {counts.docs} documents across {counts.folders} folders
            </ContentPanel.Summary>
          </ContentPanel>
        )}
      </div>
      <PageStatusBar items={["Documents", `${counts.docs} docs`]} />
    </div>
  );
}
