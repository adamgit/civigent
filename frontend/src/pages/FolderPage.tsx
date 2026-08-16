/**
 * Folder details page (current). Prior UI: `LEGACY_FolderPage.tsx`.
 * Swap the import in `DocsRouteResolver.tsx` to compare or roll back.
 */
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { PageStatusBar } from "../components/PageStatusBar";
import { FolderCard, type FolderBookSpine } from "../components/folder-details/FolderCard";
import { FolderFileRow } from "../components/folder-details/FolderFileRow";
import { DocumentSearchField } from "../components/DocumentSearchField";
import {
  NewFileOrFolder,
  type NewFileOrFolderSubmit,
} from "../components/folder-details/NewFileOrFolder";
import { docHref, folderHref } from "../app/docs-location";
import { apiClient } from "../services/api-client";
import type { DocumentTreeAccess, DocumentTreeEntry, ReadDocStructureResponse } from "../types/shared.js";
import type { AppLayoutOutletContext } from "../app/AppLayout";
import { DocPath, FolderPath } from "../types/shared";
import { copyTextToClipboard } from "../utils/copy-text";

interface FolderPageProps {
  folderPath: FolderPath;
}

interface ChildFolderInfo {
  path: string;
  directFileCount: number;
  directFolderCount: number;
  directFileNames: string[];
  books: FolderBookSpine[];
  access: DocumentTreeAccess | null;
}

interface FolderStats {
  childFiles: string[];
  childFolders: ChildFolderInfo[];
}

function sectionNamesFromStructure(structure: ReadDocStructureResponse["structure"]): string[] {
  const names: string[] = [];
  const walk = (nodes: ReadDocStructureResponse["structure"]) => {
    for (const node of nodes) {
      const heading = node.heading.trim();
      if (heading.length > 0) {
        names.push(heading);
      }
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  };
  walk(structure);
  return names;
}

function getDisplayName(path: string): string {
  const folder = FolderPath.tryParse(path);
  if (folder) {
    return FolderPath.displayName(folder);
  }
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function ensureMarkdownSuffix(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

function findFolderEntry(entries: DocumentTreeEntry[], folderPath: string): DocumentTreeEntry | null {
  if (folderPath === FolderPath.root) {
    return {
      type: "directory",
      name: "/",
      path: FolderPath.root,
      children: entries,
    };
  }
  const stack = [...entries];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.path === folderPath && node.type === "directory") {
      return node;
    }
    if (node.type === "directory" && Array.isArray(node.children)) {
      stack.push(...node.children);
    }
  }
  return null;
}

function countDirectChildren(entry: DocumentTreeEntry): { files: number; folders: number } {
  let files = 0;
  let folders = 0;
  for (const child of Array.isArray(entry.children) ? entry.children : []) {
    if (child.type === "file") {
      files += 1;
    } else {
      folders += 1;
    }
  }
  return { files, folders };
}

function getFolderStats(entry: DocumentTreeEntry): FolderStats {
  const childFiles: string[] = [];
  const childFolders: ChildFolderInfo[] = [];
  const directChildren = Array.isArray(entry.children) ? entry.children : [];
  for (const child of directChildren) {
    if (child.type === "file") {
      childFiles.push(child.path);
      continue;
    }
    const direct = countDirectChildren(child);
    const directFiles = (Array.isArray(child.children) ? child.children : [])
      .filter((node) => node.type === "file")
      .slice()
      .sort((a, b) =>
        getDisplayName(a.path).localeCompare(getDisplayName(b.path), undefined, {
          sensitivity: "base",
        }),
      );
    const directFileNames = directFiles.map((node) => getDisplayName(node.path));
    const books: FolderBookSpine[] = directFiles.map((node) => ({
      path: node.path,
      name: getDisplayName(node.path),
      sizeBytes: node.size_bytes ?? 0,
    }));
    childFolders.push({
      path: child.path,
      directFileCount: direct.files,
      directFolderCount: direct.folders,
      directFileNames,
      books,
      access: child.access ?? null,
    });
  }
  return { childFiles, childFolders };
}

function folderPathForClipboard(path: string): string {
  if (path === "/" || path.length === 0) {
    return "/";
  }
  return path.endsWith("/") ? path : `${path}/`;
}

function compareByName(a: string, b: string): number {
  return getDisplayName(a).localeCompare(getDisplayName(b), undefined, { sensitivity: "base" });
}

function CopyPathButton({
  path,
  label,
  copied,
  onCopied,
}: {
  path: string;
  label: string;
  copied: boolean;
  onCopied: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-faint hover:bg-section-hover hover:text-text-muted"
      title={copied ? "Copied" : "Copy path"}
      aria-label={copied ? "Path copied" : `Copy path for ${label}`}
      onClick={async (event) => {
        event.stopPropagation();
        const didCopy = await copyTextToClipboard(path);
        if (!didCopy) return;
        onCopied(path);
      }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3.5 8.5L6.5 11.5L12.5 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.25" stroke="currentColor" strokeWidth="1.25" />
          <path
            d="M10.5 5.5V4.25C10.5 3.56 9.94 3 9.25 3H4.25C3.56 3 3 3.56 3 4.25V9.25C3 9.94 3.56 10.5 4.25 10.5H5.5"
            stroke="currentColor"
            strokeWidth="1.25"
          />
        </svg>
      )}
    </button>
  );
}

function FolderOverflowMenu({
  busy,
  onRename,
  onDelete,
}: {
  busy: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded border-none bg-transparent text-[15px] leading-none text-text-faint hover:bg-section-hover hover:text-text-secondary"
        title="Folder actions"
        aria-label="Folder actions"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={busy}
        onClick={() => setOpen((prev) => !prev)}
      >
        &#8943;
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-[7.5rem] rounded-md border border-folder-card-border bg-canvas-bg py-1 shadow-sm"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full border-none bg-transparent px-3 py-1.5 text-left text-[12px] text-text-secondary hover:bg-section-hover hover:text-text-primary"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full border-none bg-transparent px-3 py-1.5 text-left text-[12px] text-folder-danger hover:bg-section-hover hover:text-folder-danger-hover"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            {busy ? "Working..." : "Delete"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ParentPathIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 13H8V4"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.25 6.5L8 3.5L10.75 6.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderGlyphIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.25A1.25 1.25 0 0 1 3.75 3h3.1l1.2 1.35h4.2A1.25 1.25 0 0 1 13.5 5.6v6.15A1.25 1.25 0 0 1 12.25 13H3.75A1.25 1.25 0 0 1 2.5 11.75V4.25Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderPathBreadcrumb({ folderPath }: { folderPath: FolderPath }) {
  const parts = folderPath.split("/").filter(Boolean);
  const segmentClass =
    "font-inherit text-inherit no-underline hover:text-text-secondary hover:underline";
  const slashClass = "mx-1 shrink-0 text-folder-new";

  return (
    <span
      className={`inline-flex w-max items-center whitespace-nowrap font-ui text-[22px] leading-tight tracking-tight ${
        parts.length === 0 ? "max-md:hidden" : ""
      }`}
    >
      <span
        className="mr-1.5 hidden shrink-0 text-text-muted max-md:inline-flex"
        title="Parent folder path"
      >
        <ParentPathIcon />
      </span>
      <span className="mr-1.5 inline-flex shrink-0 text-folder-new max-md:hidden">
        <FolderGlyphIcon size={18} />
      </span>
      <span className={slashClass} aria-hidden="true">
        /
      </span>
      <Link
        to={folderHref(FolderPath.root)}
        className={`shrink-0 text-text-faint ${segmentClass}`}
        aria-label="Open documents root"
      >
        docs
      </Link>
      <span className={slashClass} aria-hidden="true">
        /
      </span>
      {parts.map((part, index) => {
        const segmentPath = `/${parts.slice(0, index + 1).join("/")}`;
        const isLast = index === parts.length - 1;
        return (
          <span
            key={segmentPath}
            className={`inline-flex shrink-0 items-center ${isLast ? "max-md:hidden" : ""}`}
          >
            {isLast ? (
              <span className="font-semibold text-text-primary">{part}</span>
            ) : (
              <Link
                to={folderHref(FolderPath.parse(segmentPath))}
                className={`text-text-faint ${segmentClass}`}
                aria-label={`Open folder ${segmentPath}`}
              >
                {part}
              </Link>
            )}
            <span className={slashClass} aria-hidden="true">
              /
            </span>
          </span>
        );
      })}
    </span>
  );
}

function sectionLabelClassName() {
  return "mb-3 font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint";
}

export function FolderPage({ folderPath }: FolderPageProps) {
  const navigate = useNavigate();
  const { entries, treeLoading, refreshTree, subscribeDocSectionNamesChanged } =
    useOutletContext<AppLayoutOutletContext>();
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copiedPathTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [folderOpBusy, setFolderOpBusy] = useState(false);
  const [folderDetailsSectionNamesCache, setFolderDetailsSectionNamesCache] = useState<
    Record<string, string[]>
  >({});
  const folderDetailsSectionNamesCacheRef = useRef<Record<string, string[]>>({});
  const updateFolderDetailsSectionNamesCache = useCallback(
    (updater: (previous: Record<string, string[]>) => Record<string, string[]>) => {
      const next = updater(folderDetailsSectionNamesCacheRef.current);
      folderDetailsSectionNamesCacheRef.current = next;
      setFolderDetailsSectionNamesCache(next);
    },
    [],
  );
  const [filterQuery, setFilterQuery] = useState("");
  const isRoot = folderPath === FolderPath.root;

  const folderEntry = useMemo(() => findFolderEntry(entries, folderPath), [entries, folderPath]);
  const stats = useMemo(() => (folderEntry ? getFolderStats(folderEntry) : null), [folderEntry]);
  const childFilesKey = stats === null ? null : stats.childFiles.join("\n");
  const childFiles = useMemo(() => {
    if (childFilesKey === null) return null;
    if (childFilesKey.length === 0) return [];
    return childFilesKey.split("\n");
  }, [childFilesKey]);
  const folderClipboardPath = folderPathForClipboard(folderPath);

  const sortedFolders = useMemo(() => {
    if (!stats) return [];
    return [...stats.childFolders].sort((a, b) => compareByName(a.path, b.path));
  }, [stats]);

  const sortedFiles = useMemo(() => {
    if (!stats) return [];
    return [...stats.childFiles].sort(compareByName);
  }, [stats]);

  const filter = filterQuery.trim().toLowerCase();

  const visibleFiles = useMemo(() => {
    if (!filter) return sortedFiles;
    return sortedFiles.filter((path) => {
      if (getDisplayName(path).toLowerCase().includes(filter)) {
        return true;
      }
      return (folderDetailsSectionNamesCache[path] ?? []).some((name) =>
        name.toLowerCase().includes(filter),
      );
    });
  }, [sortedFiles, filter, folderDetailsSectionNamesCache]);

  const markPathCopied = (path: string) => {
    setCopiedPath(path);
    if (copiedPathTimeoutRef.current) {
      clearTimeout(copiedPathTimeoutRef.current);
    }
    copiedPathTimeoutRef.current = setTimeout(() => setCopiedPath(null), 1500);
  };

  useEffect(() => {
    return () => {
      if (copiedPathTimeoutRef.current) {
        clearTimeout(copiedPathTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setFilterQuery("");
  }, [folderPath]);

  useEffect(() => {
    if (childFiles === null || childFiles.length === 0) {
      if (Object.keys(folderDetailsSectionNamesCacheRef.current).length > 0) {
        updateFolderDetailsSectionNamesCache(() => ({}));
      }
      return;
    }
    const inFolder = new Set(childFiles);
    const staleKeys = Object.keys(folderDetailsSectionNamesCacheRef.current).filter(
      (path) => !inFolder.has(path),
    );
    if (staleKeys.length > 0) {
      updateFolderDetailsSectionNamesCache((previous) => {
        const next = { ...previous };
        for (const key of staleKeys) {
          delete next[key];
        }
        return next;
      });
    }
    const missing = childFiles.filter(
      (path) => !(path in folderDetailsSectionNamesCacheRef.current),
    );
    if (missing.length === 0) {
      return;
    }
    let cancelled = false;
    Promise.all(
      missing.map(async (path) => {
        try {
          const response = await apiClient.getWorkspaceDocumentStructure(DocPath.parse(path));
          return [path, sectionNamesFromStructure(response.structure)] as [string, string[]];
        } catch {
          return [path, []] as [string, string[]];
        }
      }),
    ).then((results) => {
      if (cancelled) {
        return;
      }
      updateFolderDetailsSectionNamesCache((previous) => {
        const next = { ...previous };
        for (const [path, names] of results) {
          if (inFolder.has(path)) {
            next[path] = names;
          }
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [childFiles, updateFolderDetailsSectionNamesCache]);

  useEffect(() => {
    return subscribeDocSectionNamesChanged(({ docPath: changedDocPath, sectionHeadings }) => {
      if (!(changedDocPath in folderDetailsSectionNamesCacheRef.current)) {
        return;
      }
      if (sectionHeadings !== null) {
        updateFolderDetailsSectionNamesCache((previous) => ({
          ...previous,
          [changedDocPath]: sectionHeadings,
        }));
        return;
      }
      const changedDoc = DocPath.tryParse(changedDocPath);
      if (!changedDoc) {
        return;
      }
      apiClient
        .getWorkspaceDocumentStructure(changedDoc)
        .then((response) => {
          if (!(changedDocPath in folderDetailsSectionNamesCacheRef.current)) {
            return;
          }
          updateFolderDetailsSectionNamesCache((previous) => ({
            ...previous,
            [changedDocPath]: sectionNamesFromStructure(response.structure),
          }));
        })
        .catch(() => { /* non-fatal background fetch */ });
    });
  }, [subscribeDocSectionNamesChanged, updateFolderDetailsSectionNamesCache]);

  const handleRenameFolder = async (event: FormEvent) => {
    event.preventDefault();
    if (folderOpBusy || isRoot) {
      return;
    }
    let newFolder: FolderPath;
    try {
      newFolder = FolderPath.normalize(renameValue);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
      return;
    }
    setFolderOpBusy(true);
    setRenameError(null);
    try {
      const res = await apiClient.renameFolder(folderPath, newFolder);
      await refreshTree();
      setRenaming(false);
      navigate(folderHref(FolderPath.parse(res.new_folder_path)));
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setFolderOpBusy(false);
    }
  };

  const handleDeleteFolder = async () => {
    if (folderOpBusy || isRoot) {
      return;
    }
    if (!window.confirm("Delete this folder and every document in it? This cannot be undone.")) {
      return;
    }
    setFolderOpBusy(true);
    setDeleteError(null);
    try {
      await apiClient.deleteFolder(folderPath);
      await refreshTree();
      navigate(folderHref(FolderPath.parentOf(folderPath)));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setFolderOpBusy(false);
    }
  };

  const handleCreate = async ({ name, content, isFolder }: NewFileOrFolderSubmit) => {
    setCreating(true);
    setCreateError(null);
    try {
      if (isFolder) {
        const folderName = name.replace(/\/+$/, "").trim();
        if (!folderName) {
          throw new Error("Folder name is required.");
        }
        const newFolder = FolderPath.normalize(
          folderPath === FolderPath.root ? `/${folderName}` : `${folderPath}/${folderName}`,
        );
        // Empty folders are not stored; a placeholder doc materializes the path.
        await apiClient.createDocument(DocPath.fileInFolder(newFolder, "readme.md"), "");
        await refreshTree();
        navigate(folderHref(newFolder));
        return;
      }

      const fileName = ensureMarkdownSuffix(name.replace(/\/+$/, "").trim());
      if (!fileName || fileName === ".md") {
        throw new Error("File name is required.");
      }
      const nextDocPath = DocPath.fileInFolder(folderPath, fileName);
      await apiClient.createDocument(nextDocPath, content);
      await refreshTree();
      navigate(docHref(nextDocPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCreateError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-folder-page-bg">
      <div className="flex-1 overflow-auto px-8 py-7 font-ui max-md:px-4 max-md:py-4">
        {treeLoading ? (
          <p className="text-xs text-text-muted">Loading folder details...</p>
        ) : null}

        {!treeLoading && !folderEntry ? (
          <p className="text-xs text-status-red">
            Folder not found in the current tree: <code>{folderPath}</code>
          </p>
        ) : null}

        {folderEntry && stats ? (
          <div className="w-full max-w-5xl">
            <div className="pb-5">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint max-md:hidden">
                  Folder
                </p>
                <h1 className="mb-1.5 hidden min-w-0 items-center gap-2 font-body text-[32px] font-bold leading-tight tracking-tight text-text-primary max-md:flex">
                  <span className="inline-flex shrink-0 text-folder-new">
                    <FolderGlyphIcon size={28} />
                  </span>
                  <span className="flex min-w-0 items-center gap-0.5">
                    <span className="min-w-0 truncate">
                      {isRoot ? "docs" : FolderPath.displayName(folderPath)}
                    </span>
                    <span className="shrink-0 text-folder-new" aria-hidden="true">
                      /
                    </span>
                    <CopyPathButton
                      path={folderClipboardPath}
                      label={FolderPath.displayName(folderPath)}
                      copied={copiedPath === folderClipboardPath}
                      onCopied={markPathCopied}
                    />
                  </span>
                </h1>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1 overflow-x-auto">
                    <FolderPathBreadcrumb folderPath={folderPath} />
                  </div>
                  <span className="max-md:hidden">
                    <CopyPathButton
                      path={folderClipboardPath}
                      label={FolderPath.displayName(folderPath)}
                      copied={copiedPath === folderClipboardPath}
                      onCopied={markPathCopied}
                    />
                  </span>
                  {!isRoot && renaming ? (
                    <form onSubmit={handleRenameFolder} className="flex shrink-0 items-center gap-2">
                      <input
                        type="text"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        className="input-field min-w-[200px] py-1.5 text-xs"
                        disabled={folderOpBusy}
                        aria-label="New folder path"
                      />
                      <button type="submit" className="btn-primary px-3 py-1.5 text-xs" disabled={folderOpBusy}>
                        {folderOpBusy ? "Renaming..." : "Save"}
                      </button>
                      <button
                        type="button"
                        className="border-none bg-transparent p-0 text-[12px] text-text-faint hover:text-text-muted"
                        disabled={folderOpBusy}
                        onClick={() => {
                          setRenaming(false);
                          setRenameError(null);
                        }}
                      >
                        cancel
                      </button>
                    </form>
                  ) : null}
                  {!isRoot && !renaming ? (
                    <div className="ml-auto">
                      <FolderOverflowMenu
                        busy={folderOpBusy}
                        onRename={() => {
                          setRenameValue(folderPath);
                          setRenameError(null);
                          setRenaming(true);
                        }}
                        onDelete={handleDeleteFolder}
                      />
                    </div>
                  ) : null}
                </div>
              <p className="mt-2 text-[12px] text-text-faint max-md:hidden">
                {stats.childFiles.length} files · {stats.childFolders.length} folders
                {" — hover any item for a preview."}
              </p>
            </div>

            {renameError ? <p className="mb-3 text-xs text-status-red">{renameError}</p> : null}
            {deleteError ? <p className="mb-3 text-xs text-status-red">{deleteError}</p> : null}

            <div className="flex flex-col gap-y-8 border-t border-folder-divider pt-6 md:flex-row md:gap-y-0">
              {sortedFolders.length > 0 ? (
                <section className="min-w-0 md:flex-[1_2_20rem] md:pr-8">
                  <h2 className={sectionLabelClassName()}>Folders · {sortedFolders.length}</h2>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {sortedFolders.map((folder) => {
                      const childFolderPath = FolderPath.tryParse(folder.path);
                      if (!childFolderPath) {
                        return null;
                      }
                      return (
                        <li key={folder.path} className="min-w-0">
                          <FolderCard
                            name={getDisplayName(folder.path)}
                            fileCount={folder.directFileCount}
                            folderCount={folder.directFolderCount}
                            fileNames={folder.directFileNames}
                            books={folder.books}
                            access={folder.access}
                            to={folderHref(childFolderPath)}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              <section
                className={`min-w-0 md:flex-[2_1_28rem] ${
                  sortedFolders.length > 0 ? "border-folder-divider md:border-l md:pl-8" : ""
                }`}
              >
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h2 className="m-0 font-ui text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint">
                    Files · {visibleFiles.length}
                  </h2>
                  <DocumentSearchField
                    placeholder="Filter documents..."
                    value={filterQuery}
                    onChange={setFilterQuery}
                    className="w-44 shrink-0 text-right max-md:hidden"
                  />
                </div>
                {visibleFiles.length === 0 ? (
                  <p className="mb-2 text-xs text-text-muted">
                    {filter ? "No matching files." : "No files in this folder."}
                  </p>
                ) : (
                  <ul className="m-0 list-none p-0">
                    {visibleFiles.map((path) => (
                      <li key={path} className="border-b border-folder-divider last:border-b-0">
                        <FolderFileRow
                          name={getDisplayName(path)}
                          sectionNames={folderDetailsSectionNamesCache[path]}
                          to={docHref(DocPath.parse(path))}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                <div className="border-t border-folder-divider max-md:hidden">
                  <NewFileOrFolder busy={creating} error={createError} onSubmit={handleCreate} />
                </div>
              </section>
            </div>
          </div>
        ) : null}
      </div>
      {folderEntry && stats ? (
        <div className="hidden shrink-0 border-t border-folder-divider bg-folder-page-bg px-4 py-3 max-md:block">
          <div className="flex items-stretch gap-2">
            <Link
              to="/"
              className="inline-flex shrink-0 items-center justify-center rounded-xl border border-folder-card-border bg-canvas-bg px-4 font-ui text-[15px] font-semibold text-text-primary no-underline"
            >
              Home
            </Link>
            <div className="min-w-0 flex-1">
              <NewFileOrFolder
                variant="compact"
                busy={creating}
                error={createError}
                onSubmit={handleCreate}
              />
            </div>
          </div>
        </div>
      ) : null}
      <div className="max-md:hidden">
        <PageStatusBar items={["Folder", folderPath]} />
      </div>
    </div>
  );
}
