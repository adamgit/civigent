import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import type { DocumentTreeEntry } from "../types/shared.js";

import { DocsLocation, docHref, folderHref } from "../app/docs-location";
import { copyTextToClipboard } from "../utils/copy-text";
import { DocPath, FolderPath } from "../types/shared";

export type TreeDragSource =
  | { kind: "doc"; path: DocPath }
  | { kind: "folder"; path: FolderPath };

export type TreeMoveDest =
  | { kind: "doc"; from: DocPath; to: DocPath }
  | { kind: "folder"; from: FolderPath; to: FolderPath };

export function computeTreeMoveDest(source: TreeDragSource, destParent: FolderPath): TreeMoveDest | null {
  const lastSegment = source.path.split("/").pop() ?? "";
  const joined = destParent === FolderPath.root ? `/${lastSegment}` : `${destParent}/${lastSegment}`;
  if (source.kind === "doc") {
    const to = DocPath.tryParse(joined);
    if (!to || to === source.path) return null;
    return { kind: "doc", from: source.path, to };
  }
  const to = FolderPath.tryParse(joined);
  if (!to || FolderPath.contains(source.path, to)) return null;
  return { kind: "folder", from: source.path, to };
}

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

interface DocumentsTreeNavProps {
  entries: DocumentTreeEntry[];
  emptyLabel?: string;
  storageKey?: string;
  forceExpandAll?: boolean;
  badgedDocPaths?: Iterable<string>;
  flashDocKinds?: ReadonlyMap<string, "human" | "agent">;
  onDocumentOpen?: (docPath: string) => void;
  onCreateDocumentInFolder?: (folderPath: string) => void;
  dragSource?: TreeDragSource | null;
  onDragSourceChange?: (source: TreeDragSource | null) => void;
  dropParentFolder?: FolderPath | null;
  onDropParentFolderChange?: (parent: FolderPath | null) => void;
  onMoveDocument?: (from: DocPath, to: DocPath) => void;
  onMoveFolder?: (from: FolderPath, to: FolderPath) => void;
}

export function DocumentsTreeNav({
  entries,
  emptyLabel = "No documents found.",
  storageKey = "ks_docs_tree_expanded",
  forceExpandAll = false,
  badgedDocPaths,
  flashDocKinds,
  onDocumentOpen,
  onCreateDocumentInFolder,
  dragSource,
  onDragSourceChange,
  dropParentFolder,
  onDropParentFolderChange,
  onMoveDocument,
  onMoveFolder,
}: DocumentsTreeNavProps) {
  const location = useLocation();
  const docsLoc = useMemo(() => DocsLocation.fromPathname(location.pathname), [location.pathname]);
  const selectedFilePath = docsLoc?.kind === "doc" ? docsLoc.docPath : null;
  const selectedFolderPath = docsLoc?.kind === "folder" ? docsLoc.folderPath : null;
  const selectedPath = selectedFilePath ?? selectedFolderPath;
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpandedState(storageKey));
  const [copiedFolderPath, setCopiedFolderPath] = useState<string | null>(null);
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
      <Link
        to={`/imports?into=${encodeURIComponent(folderPath)}`}
        title={`Import files into ${getDisplayName(folderPath)}`}
        aria-label={`Import files into ${getDisplayName(folderPath)}`}
        className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-sidebar-text/55 hover:text-accent no-underline p-0 text-[11px] leading-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
        }}
      >
        &#8593;
      </Link>
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

  const dragSourceHandlers = (source: TreeDragSource) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData("text/plain", source.path);
      event.dataTransfer.effectAllowed = "move";
      onDragSourceChange?.(source);
    },
    onDragEnd: () => {
      onDragSourceChange?.(null);
      onDropParentFolderChange?.(null);
    },
  });

  const dropTargetHandlers = (destParent: FolderPath | null) =>
    destParent == null
      ? {}
      : {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!dragSource || !computeTreeMoveDest(dragSource, destParent)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (dropParentFolder !== destParent) onDropParentFolderChange?.(destParent);
          },
          onDragLeave: (event: DragEvent<HTMLElement>) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            if (dropParentFolder === destParent) onDropParentFolderChange?.(null);
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            if (!dragSource) return;
            event.preventDefault();
            onDropParentFolderChange?.(null);
            const dest = computeTreeMoveDest(dragSource, destParent);
            onDragSourceChange?.(null);
            if (!dest) return;
            if (dest.kind === "doc") onMoveDocument?.(dest.from, dest.to);
            else onMoveFolder?.(dest.from, dest.to);
          },
        };

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
                  }${dropParentFolder != null && dropParentFolder === node.path ? " outline outline-2 -outline-offset-2 outline-accent bg-white/60" : ""}`}
                  style={{ paddingLeft }}
                  onClick={() => toggleDirectory(node.path)}
                  {...(nodeFolderPath ? dragSourceHandlers({ kind: "folder", path: nodeFolderPath }) : {})}
                  {...dropTargetHandlers(nodeFolderPath)}
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
          const fileDocPath = DocPath.parse(node.path);
          const fileParentFolder = FolderPath.tryParse(
            node.path.lastIndexOf("/") === 0 ? "/" : node.path.slice(0, node.path.lastIndexOf("/")),
          );
          return (
            <Link
              key={node.path}
              ref={isSelected ? selectedScrollRef : undefined}
              to={docHref(fileDocPath)}
              onClick={handleClick}
              {...dragSourceHandlers({ kind: "doc", path: fileDocPath })}
              {...dropTargetHandlers(fileParentFolder)}
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
      {sortedEntries.length === 0 ? (
        <p className="text-xs text-text-faint px-1.5 py-2">{emptyLabel}</p>
      ) : (
        renderEntries(sortedEntries, 0)
      )}
    </>
  );
}
