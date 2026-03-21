import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { DocumentTreeEntry, EvaluatedSection } from "../types/shared.js";
import { apiClient } from "../services/api-client.js";

function toRouteDocPath(treePath: string): string {
  return treePath.replace(/^\/+/, "");
}

function toCanonicalDocPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseRouteDocPath(pathname: string): string | null {
  if (!pathname.startsWith("/docs/")) {
    return null;
  }
  let encodedPath = pathname.slice("/docs/".length);
  if (!encodedPath) {
    return null;
  }
  for (const suffix of ["/edit", "/reconcile"]) {
    if (encodedPath.endsWith(suffix)) {
      encodedPath = encodedPath.slice(0, -suffix.length);
      break;
    }
  }
  if (!encodedPath) {
    return null;
  }
  try {
    return toCanonicalDocPath(decodeURIComponent(encodedPath));
  } catch {
    return toCanonicalDocPath(encodedPath);
  }
}

function readExpandedState(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return new Set<string>();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set<string>();
  }
}

function writeExpandedState(storageKey: string, value: Set<string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(Array.from(value)));
  } catch {
    // Ignore localStorage failures in constrained environments.
  }
}

function collectDirectoryPaths(entries: DocumentTreeEntry[]): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: DocumentTreeEntry[]) => {
    for (const node of nodes) {
      if (node.type !== "directory") {
        continue;
      }
      out.add(node.path);
      if (Array.isArray(node.children)) {
        walk(node.children);
      }
    }
  };
  walk(entries);
  return out;
}

function findDirectoryAncestors(entries: DocumentTreeEntry[], docPath: string): string[] {
  const walk = (nodes: DocumentTreeEntry[], ancestors: string[]): string[] | null => {
    for (const node of nodes) {
      if (node.type === "file") {
        if (node.path === docPath) {
          return ancestors;
        }
        continue;
      }
      const nextAncestors = [...ancestors, node.path];
      const found = walk(Array.isArray(node.children) ? node.children : [], nextAncestors);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return walk(entries, []) ?? [];
}

function getDisplayName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function readFilesAsText(fileList: FileList): Promise<{ name: string; content: string }[]> {
  const promises: Promise<{ name: string; content: string }>[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    promises.push(
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, content: reader.result as string });
        reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        reader.readAsText(file);
      }),
    );
  }
  return Promise.all(promises);
}

interface BlockedImportInfo {
  proposalId: string;
  blockedSections: EvaluatedSection[];
}

interface DocumentsTreeNavProps {
  entries: DocumentTreeEntry[];
  emptyLabel?: string;
  storageKey?: string;
  forceExpandAll?: boolean;
  badgedDocPaths?: Iterable<string>;
  onDocumentOpen?: (docPath: string) => void;
  onTreeRefresh?: () => void;
}

export function DocumentsTreeNav({
  entries,
  emptyLabel = "No documents found.",
  storageKey = "ks_docs_tree_expanded",
  forceExpandAll = false,
  badgedDocPaths,
  onDocumentOpen,
  onTreeRefresh,
}: DocumentsTreeNavProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const selectedDocPath = useMemo(() => parseRouteDocPath(location.pathname), [location.pathname]);
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpandedState(storageKey));
  const [importingFolder, setImportingFolder] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [blockedImport, setBlockedImport] = useState<BlockedImportInfo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFolderRef = useRef<string>("/");

  const sortedEntries = useMemo(() => entries, [entries]);
  const badgeSet = useMemo(() => new Set(badgedDocPaths ?? []), [badgedDocPaths]);
  const allDirectoryPaths = useMemo(() => collectDirectoryPaths(entries), [entries]);

  useEffect(() => {
    writeExpandedState(storageKey, expanded);
  }, [expanded, storageKey]);

  useEffect(() => {
    setExpanded((previous) => {
      const next = new Set(Array.from(previous).filter((path) => allDirectoryPaths.has(path)));
      if (selectedDocPath) {
        for (const path of findDirectoryAncestors(entries, selectedDocPath)) {
          next.add(path);
        }
      }
      if (next.size === previous.size && Array.from(next).every((path) => previous.has(path))) {
        return previous;
      }
      return next;
    });
  }, [allDirectoryPaths, entries, selectedDocPath]);

  // Auto-clear import success message
  useEffect(() => {
    if (!importMessage) return;
    const timer = window.setTimeout(() => setImportMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [importMessage]);

  const effectiveExpanded = useMemo(() => {
    if (!forceExpandAll) {
      return expanded;
    }
    return new Set([...expanded, ...allDirectoryPaths]);
  }, [allDirectoryPaths, expanded, forceExpandAll]);

  const toggleDirectory = (entryPath: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(entryPath)) {
        next.delete(entryPath);
      } else {
        next.add(entryPath);
      }
      return next;
    });
  };

  const triggerImport = useCallback((folderPath: string) => {
    pendingFolderRef.current = folderPath;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  }, []);

  const handleFileSelected = useCallback(async () => {
    const input = fileInputRef.current;
    if (!input?.files || input.files.length === 0) return;

    setImportingFolder(pendingFolderRef.current);

    try {
      const files = await readFilesAsText(input.files);
      // Create staging folder, upload files, navigate to ImportsPage
      const staging = await apiClient.createImport();
      await apiClient.uploadImportFiles(staging.import_id, files);
      navigate(`/imports?expand=${encodeURIComponent(staging.import_id)}`);
    } catch (error) {
      setImportMessage(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setImportingFolder(null);
    }
  }, [navigate]);

  const handleKeepProposal = useCallback(() => {
    setBlockedImport(null);
  }, []);

  const handleCancelImport = useCallback(async () => {
    if (!blockedImport) return;
    try {
      await apiClient.withdrawProposal(blockedImport.proposalId, "Cancelled blocked import");
      onTreeRefresh?.();
    } catch {
      // Withdrawal failure is non-fatal — proposal stays pending.
    }
    setBlockedImport(null);
  }, [blockedImport, onTreeRefresh]);

  const triggerExport = useCallback((folderPath: string) => {
    window.location.href = `/api/export?path=${encodeURIComponent(folderPath)}`;
  }, []);

  const dirActionButtons = (folderPath: string, stopPropagation = false) => (
    <span className="ml-auto flex gap-1 opacity-0 group-hover:opacity-60">
      <button
        type="button"
        title={`Export ${getDisplayName(folderPath)} as ZIP`}
        className="hover:!opacity-100 bg-transparent border-none cursor-pointer p-0 text-[11px] leading-none transition-opacity"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          triggerExport(folderPath);
        }}
      >
        &#8595;
      </button>
      <button
        type="button"
        title={`Import .md files into ${getDisplayName(folderPath)}`}
        className="hover:!opacity-100 bg-transparent border-none cursor-pointer p-0 text-[11px] leading-none transition-opacity"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          triggerImport(folderPath);
        }}
        disabled={importingFolder !== null}
      >
        &#8593;
      </button>
    </span>
  );

  const renderEntries = (nodes: DocumentTreeEntry[], depth: number) => {
    return (
      <div className="flex flex-col gap-px">
        {nodes.map((node) => {
          const paddingLeft = `${depth * 12}px`;
          if (node.type === "directory") {
            const isExpanded = effectiveExpanded.has(node.path);
            const childEntries = Array.isArray(node.children) ? node.children : [];
            return (
              <div key={node.path}>
                <div
                  role="button"
                  tabIndex={0}
                  className="group flex items-center gap-[7px] w-full px-1.5 py-[5px] rounded-[5px] text-[13px] text-sidebar-text bg-transparent border-none font-[family-name:var(--font-ui)] text-left cursor-pointer hover:bg-white/45 hover:text-sidebar-text-hover transition-all"
                  style={{ paddingLeft }}
                  onClick={() => toggleDirectory(node.path)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleDirectory(node.path); } }}
                >
                  <span className="text-[13px] opacity-45 w-4 text-center">
                    {isExpanded ? "\u{1F4C1}" : "\u{1F4C1}"}
                  </span>
                  <span className="truncate">{getDisplayName(node.path)}/</span>
                  {dirActionButtons(node.path, true)}
                </div>
                {isExpanded ? (
                  <div data-testid={`tree-node-expanded-${node.path}`}>
                    {childEntries.length > 0 ? (
                      renderEntries(childEntries, depth + 1)
                    ) : (
                      <p
                        className="text-[11px] text-text-faint px-1.5 py-1"
                        style={{ marginLeft: `${(depth + 1) * 12}px` }}
                      >
                        Empty folder
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          }

          const isSelected = selectedDocPath === node.path;
          const handleClick = (_event: MouseEvent<HTMLAnchorElement>) => {
            onDocumentOpen?.(node.path);
          };
          const hasBadge = badgeSet.has(node.path);
          return (
            <Link
              key={node.path}
              to={`/docs/${toRouteDocPath(node.path)}`}
              onClick={handleClick}
              data-testid={isSelected ? `tree-node-selected-${node.path}` : undefined}
              className={`flex items-center gap-[7px] px-1.5 py-[5px] rounded-[5px] text-[13px] cursor-pointer transition-all relative ${
                isSelected
                  ? "bg-sidebar-active-bg text-sidebar-active-text font-medium"
                  : "text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover"
              }`}
              style={{ paddingLeft }}
            >
              <span className="text-[13px] opacity-45 w-4 text-center">&#128196;</span>
              <span className="truncate">{getDisplayName(node.path)}</span>
              {hasBadge ? (
                <span className="ml-auto text-[10px] font-semibold px-[5px] py-px rounded-lg bg-agent-light text-agent-text">
                  new
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    );
  };

  return (
    <>
      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".md"
        multiple
        className="hidden"
        onChange={handleFileSelected}
      />

      {/* Import status message */}
      {importMessage ? (
        <div className="text-[11px] px-2 py-1 text-sidebar-text bg-white/20 rounded mx-1 mb-1">
          {importMessage}
        </div>
      ) : null}

      {/* Importing spinner */}
      {importingFolder !== null ? (
        <div className="text-[11px] px-2 py-1 text-sidebar-text opacity-60 mx-1 mb-1">
          Importing to {getDisplayName(importingFolder)}...
        </div>
      ) : null}

      {/* Root-level export/import buttons */}
      <div className="flex items-center gap-2 px-1.5 mb-0.5 justify-end">
        <button
          type="button"
          title="Export all documents as ZIP"
          className="text-[11px] text-sidebar-text opacity-50 hover:opacity-100 bg-transparent border-none cursor-pointer p-0.5 transition-opacity"
          onClick={() => triggerExport("/")}
        >
          &#8595; Export
        </button>
        <button
          type="button"
          title="Import .md files to root"
          className="text-[11px] text-sidebar-text opacity-50 hover:opacity-100 bg-transparent border-none cursor-pointer p-0.5 transition-opacity"
          onClick={() => triggerImport("/")}
          disabled={importingFolder !== null}
        >
          &#8593; Import
        </button>
      </div>

      {sortedEntries.length === 0 ? (
        <p className="text-xs text-text-faint px-1.5 py-2">{emptyLabel}</p>
      ) : (
        renderEntries(sortedEntries, 0)
      )}

      {/* Blocked import dialog */}
      {blockedImport ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-5">
            <h3 className="text-sm font-semibold mb-3">Import blocked</h3>
            <p className="text-xs text-gray-600 mb-3">
              Some sections are currently reserved or being edited. The import proposal has been
              created but cannot be committed yet.
            </p>
            <div className="max-h-48 overflow-y-auto mb-4 border rounded p-2">
              {blockedImport.blockedSections.map((section, i) => (
                <div key={i} className="text-xs py-1 border-b last:border-b-0">
                  <div className="font-medium">{section.doc_path}</div>
                  <div className="text-gray-500">
                    {section.heading_path.join(" > ")}
                    {" — "}
                    {`Reserved (human involvement: ${(section.humanInvolvement_score * 100).toFixed(0)}%)`}
                  </div>
                  {section.justification ? (
                    <div className="text-gray-400 italic">{section.justification}</div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 cursor-pointer"
                onClick={handleCancelImport}
              >
                Cancel Import
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 border-none cursor-pointer"
                onClick={handleKeepProposal}
              >
                Keep Proposal
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
