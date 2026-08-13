/**
 * Folder details page (current). Prior UI: `LEGACY_FolderPage.tsx`.
 * Swap the import in `DocsRouteResolver.tsx` to compare or roll back.
 */
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
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
import type { DocumentTreeEntry } from "../types/shared.js";
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
}

interface FolderStats {
  childFiles: string[];
  childFolders: ChildFolderInfo[];
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

function FolderPathBreadcrumb({
  folderPath,
  onNavigate,
}: {
  folderPath: FolderPath;
  onNavigate: (route: string) => void;
}) {
  const parts = folderPath.split("/").filter(Boolean);
  const segmentClass =
    "border-none bg-transparent p-0 font-inherit text-inherit cursor-pointer hover:text-text-secondary hover:underline";

  return (
    <span className="inline-flex w-max items-center whitespace-nowrap font-ui text-[22px] leading-tight tracking-tight">
      <span className="mr-1.5 inline-flex shrink-0 text-folder-new" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
          <path
            d="M2.5 4.25A1.25 1.25 0 0 1 3.75 3h3.1l1.2 1.35h4.2A1.25 1.25 0 0 1 13.5 5.6v6.15A1.25 1.25 0 0 1 12.25 13H3.75A1.25 1.25 0 0 1 2.5 11.75V4.25Z"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <button
        type="button"
        className={`shrink-0 text-text-faint ${segmentClass}`}
        onClick={() => onNavigate(folderHref(FolderPath.root))}
        aria-label="Open documents root"
      >
        docs
      </button>
      {parts.map((part, index) => {
        const segmentPath = `/${parts.slice(0, index + 1).join("/")}`;
        const isLast = index === parts.length - 1;
        return (
          <span key={segmentPath} className="inline-flex shrink-0 items-center">
            <span className="mx-1.5 shrink-0 text-folder-new">/</span>
            {isLast ? (
              <span className="font-semibold text-text-primary">{part}</span>
            ) : (
              <button
                type="button"
                className={`text-text-faint ${segmentClass}`}
                onClick={() => onNavigate(folderHref(FolderPath.parse(segmentPath)))}
                aria-label={`Open folder ${segmentPath}`}
              >
                {part}
              </button>
            )}
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
  const { entries, treeLoading, refreshTree } = useOutletContext<AppLayoutOutletContext>();
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copiedPathTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [folderOpBusy, setFolderOpBusy] = useState(false);
  const [sectionNamesByPath, setSectionNamesByPath] = useState<Record<string, string[]>>({});
  const [filterQuery, setFilterQuery] = useState("");
  const isRoot = folderPath === FolderPath.root;

  const folderEntry = useMemo(() => findFolderEntry(entries, folderPath), [entries, folderPath]);
  const stats = useMemo(() => (folderEntry ? getFolderStats(folderEntry) : null), [folderEntry]);
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
      return (sectionNamesByPath[path] ?? []).some((name) => name.toLowerCase().includes(filter));
    });
  }, [sortedFiles, filter, sectionNamesByPath]);

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
    if (!stats || stats.childFiles.length === 0) {
      setSectionNamesByPath({});
      return;
    }
    let cancelled = false;
    const paths = stats.childFiles;
    Promise.all(
      paths.map(async (path) => {
        try {
          const response = await apiClient.getWorkspaceDocumentStructure(DocPath.parse(path));
          const names: string[] = [];
          const walk = (nodes: typeof response.structure) => {
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
          walk(response.structure);
          return [path, names] as [string, string[]];
        } catch {
          return [path, []] as [string, string[]];
        }
      }),
    ).then((results) => {
      if (cancelled) {
        return;
      }
      const next: Record<string, string[]> = {};
      for (const [path, names] of results) {
        next[path] = names;
      }
      setSectionNamesByPath(next);
    });
    return () => {
      cancelled = true;
    };
  }, [stats]);

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
    <div className="flex h-full flex-col bg-folder-page-bg">
      <div className="flex-1 overflow-auto px-8 py-7 font-ui">
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
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint">
                  Folder
                </p>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 overflow-x-auto">
                    <FolderPathBreadcrumb folderPath={folderPath} onNavigate={navigate} />
                  </div>
                  <CopyPathButton
                    path={folderClipboardPath}
                    label={FolderPath.displayName(folderPath)}
                    copied={copiedPath === folderClipboardPath}
                    onCopied={markPathCopied}
                  />
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
                    <div className="flex shrink-0 items-center gap-3 text-[12px]">
                      <button
                        type="button"
                        className="border-none bg-transparent p-0 text-text-faint hover:text-text-secondary"
                        disabled={folderOpBusy}
                        onClick={() => {
                          setRenameValue(folderPath);
                          setRenameError(null);
                          setRenaming(true);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="border-none bg-transparent p-0 text-folder-danger hover:text-folder-danger-hover"
                        disabled={folderOpBusy}
                        onClick={handleDeleteFolder}
                      >
                        {folderOpBusy ? "Working..." : "Delete"}
                      </button>
                    </div>
                  ) : null}
                </div>
              <p className="mt-2 text-[12px] text-text-faint">
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
                      return (
                        <li key={folder.path} className="min-w-0">
                          <FolderCard
                            name={getDisplayName(folder.path)}
                            fileCount={folder.directFileCount}
                            folderCount={folder.directFolderCount}
                            fileNames={folder.directFileNames}
                            books={folder.books}
                            onClick={() => {
                              if (childFolderPath) {
                                navigate(folderHref(childFolderPath));
                              }
                            }}
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
                    className="w-44 shrink-0 text-right"
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
                          sectionNames={sectionNamesByPath[path]}
                          onClick={() => navigate(docHref(DocPath.parse(path)))}
                        />
                      </li>
                    ))}
                  </ul>
                )}
                <div className="border-t border-folder-divider">
                  <NewFileOrFolder busy={creating} error={createError} onSubmit={handleCreate} />
                </div>
              </section>
            </div>
          </div>
        ) : null}
      </div>
      <PageStatusBar items={["Folder", folderPath]} />
    </div>
  );
}
