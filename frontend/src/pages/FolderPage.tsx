import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ContentPanel } from "../components/ContentPanel";
import { PageStatusBar } from "../components/PageStatusBar";
import { folderRouteForPath, stripLeadingSlashForRoute } from "../app/docsRouteUtils";
import { apiClient } from "../services/api-client";
import type { DocumentTreeEntry } from "../types/shared.js";
import type { AppLayoutOutletContext } from "../app/AppLayout";
import { DocPath } from "../types/shared";

interface FolderPageProps {
  folderPath: string;
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
  if (path === "/") {
    return "/";
  }
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function ensureMarkdownSuffix(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

function buildDocPath(folderPath: string, name: string): DocPath {
  const trimmedName = name.trim().replace(/^\/+/, "");
  const baseFolder = folderPath === "/" ? "" : folderPath.replace(/\/+$/, "");
  return DocPath.parse(ensureMarkdownSuffix(`${baseFolder}/${trimmedName}`.replace(/\/{2,}/g, "/")));
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

function FolderPathBreadcrumb({
  folderPath,
  onNavigate,
}: {
  folderPath: string;
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
        onClick={() => onNavigate(folderRouteForPath("/"))}
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
                onClick={() => onNavigate(folderRouteForPath(segmentPath))}
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

  const folderEntry = useMemo(() => findFolderEntry(entries, folderPath), [entries, folderPath]);
  const stats = useMemo(() => (folderEntry ? getFolderStats(folderEntry) : null), [folderEntry]);

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
          const response = await apiClient.getWorkspaceDocumentStructure(path);
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
      await createDoc(buildDocPath(folderPath, trimmed));
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
    const nextDocPath = buildDocPath(folderPath, trimmed);
    setCreatingTextFile(true);
    setTextFileError(null);
    try {
      await apiClient.createDocument(nextDocPath);
      await apiClient.overwriteDoc(nextDocPath, textFileContent);
      await refreshTree();
      navigate(`/docs/${stripLeadingSlashForRoute(nextDocPath)}`);
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
      <SharedPageHeader title={`Folder: ${getDisplayName(folderPath)}`} backTo="/docs" />
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
                    <FolderPathBreadcrumb folderPath={folderPath} onNavigate={navigate} />
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
              </ContentPanel.Header>
              {newFileError ? (
                <div className="px-4 pt-2">
                  <p className="text-xs text-status-red">{newFileError}</p>
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
                          return (
                            <li key={path} className="min-w-0">
                              <button
                                type="button"
                                className="flex w-full min-w-0 cursor-pointer flex-col gap-0 rounded-md border-none bg-transparent px-2 py-0.5 text-left hover:bg-section-hover"
                                onClick={() =>
                                  navigate(`/docs/${stripLeadingSlashForRoute(DocPath.parse(path))}`)
                                }
                              >
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span
                                    className="w-4 shrink-0 text-center text-[13px] text-text-muted opacity-45"
                                    aria-hidden="true"
                                  >
                                    &#128196;
                                  </span>
                                  <span className="truncate text-[13px] font-medium text-accent-text">
                                    {getDisplayName(path)}
                                  </span>
                                </span>
                                {sections === undefined ? (
                                  <span className="block truncate pl-3 text-[11px] italic text-text-faint">
                                    (loading contents)
                                  </span>
                                ) : sections.length === 0 ? (
                                  <span className="block truncate pl-3 text-[11px] font-medium text-text-secondary">
                                    No sections
                                  </span>
                                ) : (
                                  <span
                                    className="block truncate pl-3 text-[11px] font-medium text-text-secondary"
                                    title={sectionTitle}
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
                                  </span>
                                )}
                              </button>
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
                        {stats.childFolders.map((folder) => (
                          <li key={folder.path} className="min-w-0">
                            <button
                              type="button"
                              className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-md border-none bg-transparent px-2 py-0.5 text-left hover:bg-section-hover"
                              onClick={() => navigate(`/docs${folder.path}`)}
                            >
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="shrink-0 text-text-muted" aria-hidden="true">
                                  &#128193;
                                </span>
                                <span className="truncate text-[13px] font-medium text-accent-text">
                                  {getDisplayName(folder.path)}
                                </span>
                              </span>
                              <span className="shrink-0 text-[11px] text-text-faint">
                                {formatFolderChildCounts(folder)}
                              </span>
                            </button>
                          </li>
                        ))}
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
