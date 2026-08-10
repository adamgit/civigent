import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type {
  DocumentTreeEntry,
  AgentWritePolicyTarget,
  HumanInvolvementTargetDetails,
} from "../types/shared.js";
import { apiClient } from "../services/api-client.js";

import { DocsLocation, docHref, folderHref } from "../app/docs-location";
import { copyTextToClipboard } from "../utils/copy-text";
import { DocPath, FolderPath } from "../types/shared";

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll") return parent;
    parent = parent.parentElement;
  }
  return null;
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

interface BlockedImportInfo {
  proposalId: string;
  blockedSections: AgentWritePolicyTarget<HumanInvolvementTargetDetails>[];
}

interface DocumentsTreeNavProps {
  entries: DocumentTreeEntry[];
  emptyLabel?: string;
  storageKey?: string;
  forceExpandAll?: boolean;
  badgedDocPaths?: Iterable<string>;
  flashDocKinds?: ReadonlyMap<string, "human" | "agent">;
  onDocumentOpen?: (docPath: string) => void;
  onTreeRefresh?: () => void;
  onCreateDocumentInFolder?: (folderPath: string) => void;
}

export function DocumentsTreeNav({
  entries,
  emptyLabel = "No documents found.",
  storageKey = "ks_docs_tree_expanded",
  forceExpandAll = false,
  badgedDocPaths,
  flashDocKinds,
  onDocumentOpen,
  onTreeRefresh,
  onCreateDocumentInFolder,
}: DocumentsTreeNavProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const docsLoc = useMemo(() => DocsLocation.fromPathname(location.pathname), [location.pathname]);
  const selectedFilePath = docsLoc?.kind === "doc" ? docsLoc.docPath : null;
  const selectedFolderPath = docsLoc?.kind === "folder" ? docsLoc.folderPath : null;
  const selectedPath = selectedFilePath ?? selectedFolderPath;
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpandedState(storageKey));
  const [importingFolder, setImportingFolder] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [blockedImport, setBlockedImport] = useState<BlockedImportInfo | null>(null);
  const [copiedFolderPath, setCopiedFolderPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFolderRef = useRef<string>("/");
  const lastScrolledPathRef = useRef<string | null>(null);
  const copiedFolderTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedScrollRef = useCallback(
    (el: HTMLElement | null) => {
      if (!el || !selectedPath) return;
      if (lastScrolledPathRef.current === selectedPath) return;
      lastScrolledPathRef.current = selectedPath;
      requestAnimationFrame(() => {
        const container = findScrollParent(el);
        if (!container) return;
        const cRect = container.getBoundingClientRect();
        const eRect = el.getBoundingClientRect();
        const margin = cRect.height * 0.1;
        if (eRect.top >= cRect.top + margin && eRect.bottom <= cRect.bottom - margin) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    },
    [selectedPath],
  );

  const sortedEntries = useMemo(() => entries, [entries]);
  const badgeSet = useMemo(() => new Set(badgedDocPaths ?? []), [badgedDocPaths]);
  const allDirectoryPaths = useMemo(() => collectDirectoryPaths(entries), [entries]);
  useEffect(() => {
    writeExpandedState(storageKey, expanded);
  }, [expanded, storageKey]);

  useEffect(() => {
    setExpanded((previous) => {
      const next = new Set(Array.from(previous).filter((path) => allDirectoryPaths.has(path)));
      if (selectedPath) {
        for (const path of findDirectoryAncestors(entries, selectedPath)) {
          next.add(path);
        }
      }
      if (next.size === previous.size && Array.from(next).every((path) => previous.has(path))) {
        return previous;
      }
      return next;
    });
  }, [allDirectoryPaths, entries, selectedPath]);

  // Auto-clear import success message
  useEffect(() => {
    if (!importMessage) return;
    const timer = window.setTimeout(() => setImportMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [importMessage]);

  useEffect(() => {
    return () => {
      if (copiedFolderTimeoutRef.current) {
        clearTimeout(copiedFolderTimeoutRef.current);
      }
    };
  }, []);

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
      const files = Array.from(input.files).filter((file) => file.name.toLowerCase().endsWith(".md"));
      if (files.length === 0) {
        throw new Error("No .md files selected.");
      }
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
    <span className="flex items-center gap-1 shrink-0">
      {/* Export/import stay in layout (opacity only) so hover does not resize the sidebar */}
      <button
        type="button"
        title={`Export ${getDisplayName(folderPath)} as ZIP`}
        aria-label={`Export ${getDisplayName(folderPath)} as ZIP`}
        className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-sidebar-text/55 hover:text-accent bg-transparent border-none cursor-pointer p-0 text-[11px] leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
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
        aria-label={`Import .md files into ${getDisplayName(folderPath)}`}
        className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-sidebar-text/55 hover:text-accent bg-transparent border-none cursor-pointer p-0 text-[11px] leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:cursor-not-allowed"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          triggerImport(folderPath);
        }}
        disabled={importingFolder !== null}
      >
        &#8593;
      </button>
      <button
        type="button"
        title={`Create a new document in ${getDisplayName(folderPath)}`}
        aria-label={`Create a new document in ${getDisplayName(folderPath)}`}
        className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-sidebar-text/70 hover:text-accent bg-transparent border-none cursor-pointer p-0 text-[18px] font-medium leading-none transition-colors"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onCreateDocumentInFolder?.(folderPath);
        }}
      >
        +
      </button>
    </span>
  );

  const renderEntries = (nodes: DocumentTreeEntry[], folderPathLength: number) => {
    return (
      <div className="flex flex-col gap-px">
        {nodes.map((node) => {
          const paddingLeft = `${folderPathLength * 12}px`;
          if (node.type === "directory") {
            const isExpanded = effectiveExpanded.has(node.path);
            const childEntries = Array.isArray(node.children) ? node.children : [];
            const hasChildren = childEntries.length > 0;
            const isSelectedFolder = selectedFolderPath === node.path;
            const emptyFolderClass = !hasChildren && !isSelectedFolder
              ? "text-sidebar-text/40 hover:bg-white/45 hover:text-sidebar-text/55"
              : null;
            const nodeFolderPath = FolderPath.tryParse(node.path);
            const folderTo = nodeFolderPath && folderHref(nodeFolderPath);
            return (
              <div key={node.path}>
                <div
                  ref={isSelectedFolder ? selectedScrollRef : undefined}
                  className={`group flex items-center gap-[7px] w-full min-w-0 px-1.5 py-[5px] rounded-[5px] text-[13px] bg-transparent border-none font-[family-name:var(--font-ui)] text-left cursor-pointer transition-all ${
                    isSelectedFolder
                      ? "bg-sidebar-active-bg text-sidebar-active-text font-medium"
                      : emptyFolderClass
                        ?? "text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover"
                  }`}
                  style={{ paddingLeft }}
                  onClick={() => toggleDirectory(node.path)}
                >
                  <button
                    type="button"
                    title={isExpanded ? `Collapse ${getDisplayName(node.path)}` : `Expand ${getDisplayName(node.path)}`}
                    aria-label={isExpanded ? `Collapse ${getDisplayName(node.path)}` : `Expand ${getDisplayName(node.path)}`}
                    aria-expanded={isExpanded}
                    className={`w-4 shrink-0 p-0 text-center bg-transparent border-none cursor-pointer transition-colors ${
                      isSelectedFolder
                        ? "text-sidebar-active-text"
                        : hasChildren
                          ? "text-sidebar-text/55 group-hover:text-sidebar-text-hover hover:text-accent"
                          : "text-sidebar-text/35 group-hover:text-sidebar-text/55 hover:text-accent"
                    }`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleDirectory(node.path);
                    }}
                  >
                    &#128193;
                  </button>
                  <span className="flex items-center gap-0.5 min-w-0 flex-1">
                    {folderTo ? (
                      <Link
                        to={folderTo}
                        title={`Open ${getDisplayName(node.path)} folder page`}
                        aria-label={`Open ${getDisplayName(node.path)} folder page`}
                        className="truncate min-w-0 p-0 text-left font-inherit text-inherit no-underline hover:text-accent"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        {getDisplayName(node.path)}/
                      </Link>
                    ) : (
                      <span className="truncate min-w-0 p-0 text-left">{getDisplayName(node.path)}/</span>
                    )}
                    <button
                      type="button"
                      className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity ${
                        isSelectedFolder
                          ? "text-sidebar-active-text/70 hover:text-sidebar-active-text hover:bg-black/5"
                          : "text-sidebar-text/55 hover:text-accent hover:bg-white/50"
                      }`}
                      title={copiedFolderPath === node.path ? "Copied" : "Copy folder path"}
                      aria-label={copiedFolderPath === node.path ? "Folder path copied" : `Copy path for ${getDisplayName(node.path)}`}
                      onClick={async (event) => {
                        event.stopPropagation();
                        const folderPath = node.path.endsWith("/") ? node.path : `${node.path}/`;
                        const didCopy = await copyTextToClipboard(folderPath);
                        if (!didCopy) return;
                        setCopiedFolderPath(node.path);
                        if (copiedFolderTimeoutRef.current) {
                          clearTimeout(copiedFolderTimeoutRef.current);
                        }
                        copiedFolderTimeoutRef.current = setTimeout(() => setCopiedFolderPath(null), 1500);
                      }}
                    >
                      {copiedFolderPath === node.path ? (
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <rect x="5.5" y="5.5" width="8" height="8" rx="1.25" stroke="currentColor" strokeWidth="1.25" />
                          <path d="M10.5 5.5V4.25C10.5 3.56 9.94 3 9.25 3H4.25C3.56 3 3 3.56 3 4.25V9.25C3 9.94 3.56 10.5 4.25 10.5H5.5" stroke="currentColor" strokeWidth="1.25" />
                        </svg>
                      )}
                    </button>
                  </span>
                  <span className="ml-auto flex items-center gap-1 shrink-0">
                    {getDisplayName(node.path).endsWith(".md") || getDisplayName(node.path).endsWith(".sections") ? (
                      <span className="shrink-0 text-[10px] font-semibold px-[5px] py-px rounded-lg bg-red-100 text-red-800">
                        illegal name
                      </span>
                    ) : null}
                    {node.pills?.includes("skills") ? (
                      <span className="shrink-0 text-[10px] font-semibold px-[5px] py-px rounded-lg bg-orange-100 text-orange-800">
                        SKILLS
                      </span>
                    ) : null}
                    {node.pills?.includes("public") ? (
                      <span className="shrink-0 text-[10px] font-semibold px-[5px] py-px rounded-lg bg-agent-light text-agent-text">
                        PUBLIC
                      </span>
                    ) : null}
                    {dirActionButtons(node.path, true)}
                  </span>
                </div>
                {isExpanded ? (
                  <div data-testid={`tree-node-expanded-${node.path}`}>
                    {childEntries.length > 0 ? (
                      renderEntries(childEntries, folderPathLength + 1)
                    ) : (
                      <p
                        className="text-[11px] text-text-faint px-1.5 py-1"
                        style={{ marginLeft: `${(folderPathLength + 1) * 12}px` }}
                      >
                        Empty folder
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          }

          const isSelected = selectedFilePath === node.path;
          const flashKind = flashDocKinds?.get(node.path) ?? null;
          const handleClick = (_event: MouseEvent<HTMLAnchorElement>) => {
            onDocumentOpen?.(node.path);
          };
          const hasBadge = badgeSet.has(node.path);
          return (
            <Link
              key={node.path}
              ref={isSelected ? selectedScrollRef : undefined}
              to={docHref(DocPath.parse(node.path))}
              onClick={handleClick}
              data-testid={isSelected ? `tree-node-selected-${node.path}` : undefined}
              className={`flex items-center gap-[7px] min-w-0 px-1.5 py-[5px] rounded-[5px] text-[13px] cursor-pointer transition-all relative ${
                isSelected
                  ? "bg-sidebar-active-bg text-sidebar-active-text font-medium"
                  : "text-sidebar-text hover:bg-white/45 hover:text-sidebar-text-hover"
              } ${flashKind === "agent" ? "tree-row-flash-agent" : flashKind === "human" ? "tree-row-flash-human" : ""}`}
              style={{ paddingLeft }}
            >
              <span className="text-[13px] opacity-45 w-4 shrink-0 text-center">&#128196;</span>
              <span className="truncate min-w-0 flex-1">{getDisplayName(node.path)}</span>
              {hasBadge ? (
                <span className="ml-auto shrink-0 text-[10px] font-semibold px-[5px] py-px rounded-lg bg-agent-light text-agent-text">
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
              {blockedImport.blockedSections.map((target, i) => (
                <div key={i} className="text-xs py-1 border-b last:border-b-0">
                  <div className="font-medium">{target.target.doc_path}</div>
                  <div className="text-gray-500">
                    {target.target.kind === "section"
                      ? target.target.heading_path.join(" > ")
                      : "(whole document)"}
                    {" — "}
                    {/* Area M: render backend prose, not a code/score. */}
                    {target.message}
                  </div>
                  {target.details.justification ? (
                    <div className="text-gray-400 italic">{target.details.justification}</div>
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
