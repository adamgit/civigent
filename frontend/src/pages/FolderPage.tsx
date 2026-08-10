import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ContentPanel } from "../components/ContentPanel";
import { PageStatusBar } from "../components/PageStatusBar";
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
}

interface FolderStats {
  childFiles: string[];
  childFolders: ChildFolderInfo[];
  descendantFileCount: number;
  descendantFolderCount: number;
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
  let descendantFileCount = 0;
  let descendantFolderCount = 0;

  const directChildren = Array.isArray(entry.children) ? entry.children : [];
  for (const child of directChildren) {
    if (child.type === "file") {
      childFiles.push(child.path);
      continue;
    }
    const direct = countDirectChildren(child);
    childFolders.push({
      path: child.path,
      directFileCount: direct.files,
      directFolderCount: direct.folders,
    });
    const stack = [...(Array.isArray(child.children) ? child.children : [])];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      if (node.type === "file") {
        descendantFileCount += 1;
      } else {
        descendantFolderCount += 1;
        if (Array.isArray(node.children)) {
          stack.push(...node.children);
        }
      }
    }
  }

  return { childFiles, childFolders, descendantFileCount, descendantFolderCount };
}

function formatFolderChildCounts(folder: ChildFolderInfo): string {
  const fileLabel = folder.directFileCount === 1 ? "1 file" : `${folder.directFileCount} files`;
  const folderLabel = folder.directFolderCount === 1 ? "1 folder" : `${folder.directFolderCount} folders`;
  return `${fileLabel} · ${folderLabel}`;
}

function folderPathForClipboard(path: string): string {
  if (path === "/" || path.length === 0) {
    return "/";
  }
  return path.endsWith("/") ? path : `${path}/`;
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
      className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-text-primary hover:bg-[rgba(0,0,0,0.04)]"
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
    "border-none bg-transparent p-0 font-inherit text-inherit cursor-pointer hover:text-accent-text hover:underline";

  return (
    <span className="inline-flex min-w-0 max-w-full items-center truncate">
      <button
        type="button"
        className={`shrink-0 ${segmentClass}`}
        onClick={() => onNavigate(folderHref(FolderPath.root))}
        aria-label="Open documents root"
      >
        /
      </button>
      {parts.map((part, index) => {
        const segmentPath = `/${parts.slice(0, index + 1).join("/")}`;
        const isLast = index === parts.length - 1;
        return (
          <span key={segmentPath} className="inline-flex min-w-0 items-center">
            {isLast ? (
              <span className="truncate">{part}</span>
            ) : (
              <button
                type="button"
                className={`min-w-0 truncate ${segmentClass}`}
                onClick={() => onNavigate(folderHref(FolderPath.parse(segmentPath)))}
                aria-label={`Open folder ${segmentPath}`}
              >
                {part}
              </button>
            )}
            {!isLast ? <span className="shrink-0 text-text-faint">/</span> : null}
          </span>
        );
      })}
    </span>
  );
}

export function FolderPage({ folderPath }: FolderPageProps) {
  const navigate = useNavigate();
  const { entries, treeLoading, createDoc, refreshTree } = useOutletContext<AppLayoutOutletContext>();
  const [newFileName, setNewFileName] = useState("");
  const [newFileError, setNewFileError] = useState<string | null>(null);
  const [creatingNewFile, setCreatingNewFile] = useState(false);
  const [textFileName, setTextFileName] = useState("");
  const [textFileContent, setTextFileContent] = useState("");
  const [textFileError, setTextFileError] = useState<string | null>(null);
  const [creatingTextFile, setCreatingTextFile] = useState(false);
  const [sectionNamesByPath, setSectionNamesByPath] = useState<Record<string, string[]>>({});
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copiedPathTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [folderOpBusy, setFolderOpBusy] = useState(false);

  const folderEntry = useMemo(() => findFolderEntry(entries, folderPath), [entries, folderPath]);
  const stats = useMemo(() => (folderEntry ? getFolderStats(folderEntry) : null), [folderEntry]);
  const folderClipboardPath = folderPathForClipboard(folderPath);

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
          const names = response.structure
            .map((node) => node.heading.trim())
            .filter((heading) => heading.length > 0);
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
    if (folderOpBusy) {
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
    if (folderOpBusy) {
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

  const handleCreateEmptyFile = async (event: FormEvent) => {
    event.preventDefault();
    if (creatingNewFile) {
      return;
    }
    const trimmed = newFileName.trim();
    if (!trimmed) {
      setNewFileError("File name is required.");
      return;
    }
    setCreatingNewFile(true);
    setNewFileError(null);
    try {
      await createDoc(DocPath.fileInFolder(folderPath, ensureMarkdownSuffix(trimmed)));
      setNewFileName("");
    } catch (error) {
      setNewFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingNewFile(false);
    }
  };

  const handleCreateFileFromText = async (event: FormEvent) => {
    event.preventDefault();
    if (creatingTextFile) {
      return;
    }
    const trimmed = textFileName.trim();
    if (!trimmed) {
      setTextFileError("File name is required.");
      return;
    }
    setCreatingTextFile(true);
    setTextFileError(null);
    try {
      const nextDocPath = DocPath.fileInFolder(folderPath, ensureMarkdownSuffix(trimmed));
      await apiClient.createDocument(nextDocPath, textFileContent);
      await refreshTree();
      navigate(docHref(nextDocPath));
      setTextFileName("");
      setTextFileContent("");
    } catch (error) {
      setTextFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingTextFile(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <SharedPageHeader title={`Folder: ${FolderPath.displayName(folderPath)}`} backTo="/docs" />
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        {treeLoading ? (
          <p className="text-xs text-text-muted">Loading folder details...</p>
        ) : null}

        {!treeLoading && !folderEntry ? (
          <p className="text-xs text-status-red">
            Folder not found in the current tree: <code>{folderPath}</code>
          </p>
        ) : null}

        {folderEntry && stats ? (
          <>
            <ContentPanel>
              <ContentPanel.Header className="gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <ContentPanel.Title icon={<span className="text-text-muted">&#128193;</span>}>
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <FolderPathBreadcrumb folderPath={folderPath} onNavigate={navigate} />
                      <CopyPathButton
                        path={folderClipboardPath}
                        label={FolderPath.displayName(folderPath)}
                        copied={copiedPath === folderClipboardPath}
                        onCopied={markPathCopied}
                      />
                    </span>
                  </ContentPanel.Title>
                </div>
                <form
                  onSubmit={handleCreateEmptyFile}
                  className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:max-w-md sm:flex-1"
                >
                  <input
                    type="text"
                    value={newFileName}
                    onChange={(event) => setNewFileName(event.target.value)}
                    placeholder="New file name"
                    className="input-field min-w-0 flex-1 py-1.5 text-xs"
                    disabled={creatingNewFile}
                    aria-label="New file name"
                  />
                  <button
                    type="submit"
                    className="btn-primary shrink-0 px-3 py-1.5 text-xs"
                    disabled={creatingNewFile}
                  >
                    {creatingNewFile ? "Creating..." : "Create"}
                  </button>
                </form>
                {folderPath !== FolderPath.root ? (
                  renaming ? (
                    <form
                      onSubmit={handleRenameFolder}
                      className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:max-w-md"
                    >
                      <input
                        type="text"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        className="input-field min-w-0 flex-1 py-1.5 text-xs"
                        disabled={folderOpBusy}
                        aria-label="New folder path"
                      />
                      <button
                        type="submit"
                        className="btn-primary shrink-0 px-3 py-1.5 text-xs"
                        disabled={folderOpBusy}
                      >
                        {folderOpBusy ? "Renaming..." : "Save"}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary shrink-0 px-3 py-1.5 text-xs"
                        disabled={folderOpBusy}
                        onClick={() => {
                          setRenaming(false);
                          setRenameError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        className="btn-secondary px-3 py-1.5 text-xs"
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
                        className="btn-danger px-3 py-1.5 text-xs"
                        disabled={folderOpBusy}
                        onClick={handleDeleteFolder}
                      >
                        {folderOpBusy ? "Working..." : "Delete"}
                      </button>
                    </div>
                  )
                ) : null}
              </ContentPanel.Header>
              {newFileError ? (
                <div className="px-4 pt-2">
                  <p className="text-xs text-status-red">{newFileError}</p>
                </div>
              ) : null}
              {renameError ? (
                <div className="px-4 pt-2">
                  <p className="text-xs text-status-red">{renameError}</p>
                </div>
              ) : null}
              {deleteError ? (
                <div className="px-4 pt-2">
                  <p className="text-xs text-status-red">{deleteError}</p>
                </div>
              ) : null}
              <ContentPanel.Body>
                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  <div className="min-w-0">
                    <h3 className="mb-2 text-xs font-semibold text-text-secondary">Files</h3>
                    {stats.childFiles.length === 0 ? (
                      <p className="text-xs text-text-muted">No files in this folder.</p>
                    ) : (
                      <ul className="m-0 list-none space-y-0 p-0">
                        {stats.childFiles.map((path) => {
                          const sections = sectionNamesByPath[path];
                          const sectionTitle =
                            sections === undefined || sections.length === 0
                              ? undefined
                              : sections.join(" | ");
                          const openFile = () =>
                            navigate(docHref(DocPath.parse(path)));
                          return (
                            <li key={path} className="min-w-0">
                              <div className="flex w-full min-w-0 flex-col gap-0 rounded-md px-2 py-0.5 hover:bg-section-hover">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span
                                    className="w-4 shrink-0 text-center text-[13px] text-text-muted opacity-45"
                                    aria-hidden="true"
                                  >
                                    &#128196;
                                  </span>
                                  <button
                                    type="button"
                                    className="min-w-0 truncate border-none bg-transparent p-0 text-left text-[13px] font-medium text-accent-text cursor-pointer hover:underline"
                                    onClick={openFile}
                                  >
                                    {getDisplayName(path)}
                                  </button>
                                  <CopyPathButton
                                    path={path}
                                    label={getDisplayName(path)}
                                    copied={copiedPath === path}
                                    onCopied={markPathCopied}
                                  />
                                </span>
                                {sections === undefined ? (
                                  <button
                                    type="button"
                                    className="block w-full truncate border-none bg-transparent pl-5 text-left text-[11px] italic text-text-faint cursor-pointer"
                                    onClick={openFile}
                                  >
                                    (loading contents)
                                  </button>
                                ) : sections.length === 0 ? (
                                  <button
                                    type="button"
                                    className="block w-full truncate border-none bg-transparent pl-5 text-left text-[11px] font-medium text-text-secondary cursor-pointer"
                                    onClick={openFile}
                                  >
                                    No sections
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="block w-full truncate border-none bg-transparent pl-5 text-left text-[11px] font-medium text-text-secondary cursor-pointer"
                                    title={sectionTitle}
                                    onClick={openFile}
                                  >
                                    {sections.map((name, index) => (
                                      <span key={`${path}-${index}-${name}`}>
                                        {index > 0 ? (
                                          <span
                                            aria-hidden="true"
                                            className="mx-1.5 font-normal text-text-faint"
                                          >
                                            |
                                          </span>
                                        ) : null}
                                        {name}
                                      </span>
                                    ))}
                                  </button>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  <div className="min-w-0">
                    <h3 className="mb-2 text-xs font-semibold text-text-secondary">Folders</h3>
                    {stats.childFolders.length === 0 ? (
                      <p className="text-xs text-text-muted">No subfolders.</p>
                    ) : (
                      <ul className="m-0 list-none space-y-0 p-0">
                        {stats.childFolders.map((folder) => {
                          const clipboardPath = folderPathForClipboard(folder.path);
                          const childFolderPath = FolderPath.tryParse(folder.path);
                          return (
                            <li key={folder.path} className="min-w-0">
                              <div className="flex w-full min-w-0 items-center justify-between gap-3 rounded-md px-2 py-0.5 hover:bg-section-hover">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span
                                    className="w-4 shrink-0 text-center text-[13px] text-text-muted opacity-45"
                                    aria-hidden="true"
                                  >
                                    &#128193;
                                  </span>
                                  {childFolderPath ? (
                                    <button
                                      type="button"
                                      className="min-w-0 truncate border-none bg-transparent p-0 text-left text-[13px] font-medium text-accent-text cursor-pointer hover:underline"
                                      onClick={() => navigate(folderHref(childFolderPath))}
                                    >
                                      {getDisplayName(folder.path)}
                                    </button>
                                  ) : (
                                    <span className="min-w-0 truncate text-left text-[13px] font-medium text-text-secondary">
                                      {getDisplayName(folder.path)}
                                    </span>
                                  )}
                                  <CopyPathButton
                                    path={clipboardPath}
                                    label={getDisplayName(folder.path)}
                                    copied={copiedPath === clipboardPath}
                                    onCopied={markPathCopied}
                                  />
                                </span>
                                <span className="shrink-0 text-[11px] text-text-faint">
                                  {formatFolderChildCounts(folder)}
                                </span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </ContentPanel.Body>
              <ContentPanel.Summary>
                {stats.childFiles.length} files · {stats.childFolders.length} folders ·{" "}
                {stats.descendantFileCount} total files · {stats.descendantFolderCount} total subfolders
              </ContentPanel.Summary>
            </ContentPanel>

            <ContentPanel>
              <ContentPanel.Header>
                <ContentPanel.Title icon={<span className="text-text-muted">&#9998;</span>}>
                  Create from text
                </ContentPanel.Title>
              </ContentPanel.Header>
              <ContentPanel.Body>
                <form onSubmit={handleCreateFileFromText} className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={textFileName}
                    onChange={(event) => setTextFileName(event.target.value)}
                    placeholder="new-file-name"
                    className="input-field text-sm"
                    disabled={creatingTextFile}
                  />
                  <textarea
                    value={textFileContent}
                    onChange={(event) => setTextFileContent(event.target.value)}
                    rows={8}
                    placeholder="Write markdown content here..."
                    className="input-field font-[family-name:var(--font-mono)] text-xs"
                    disabled={creatingTextFile}
                  />
                  <div>
                    <button type="submit" className="btn-primary text-xs" disabled={creatingTextFile}>
                      {creatingTextFile ? "Creating..." : "Create from text"}
                    </button>
                  </div>
                </form>
                {textFileError ? <p className="mt-2 text-xs text-status-red">{textFileError}</p> : null}
              </ContentPanel.Body>
            </ContentPanel>
          </>
        ) : null}
      </div>
      <PageStatusBar items={["Folder", folderPath]} />
    </div>
  );
}
