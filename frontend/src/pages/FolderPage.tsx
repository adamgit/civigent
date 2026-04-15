import { type FormEvent, useMemo, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ContentPanel } from "../components/ContentPanel";
import { PageStatusBar } from "../components/PageStatusBar";
import { stripLeadingSlashForRoute } from "../app/docsRouteUtils";
import { apiClient } from "../services/api-client";
import type { DocumentTreeEntry } from "../types/shared.js";
import type { AppLayoutOutletContext } from "../app/AppLayout";

interface FolderPageProps {
  folderPath: string;
}

interface FolderStats {
  childFiles: string[];
  childFolders: string[];
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

function buildDocPath(folderPath: string, name: string): string {
  const trimmedName = name.trim().replace(/^\/+/, "");
  const baseFolder = folderPath === "/" ? "" : folderPath.replace(/\/+$/, "");
  return ensureMarkdownSuffix(`${baseFolder}/${trimmedName}`.replace(/\/{2,}/g, "/"));
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

function getFolderStats(entry: DocumentTreeEntry): FolderStats {
  const childFiles: string[] = [];
  const childFolders: string[] = [];
  let descendantFileCount = 0;
  let descendantFolderCount = 0;

  const directChildren = Array.isArray(entry.children) ? entry.children : [];
  for (const child of directChildren) {
    if (child.type === "file") {
      childFiles.push(child.path);
      descendantFileCount += 1;
      continue;
    }
    childFolders.push(child.path);
    descendantFolderCount += 1;
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

  const folderEntry = useMemo(() => findFolderEntry(entries, folderPath), [entries, folderPath]);
  const stats = useMemo(() => (folderEntry ? getFolderStats(folderEntry) : null), [folderEntry]);

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
              <ContentPanel.Header>
                <div>
                  <ContentPanel.Title icon={<span className="opacity-60">&#128193;</span>}>
                    {folderPath}
                  </ContentPanel.Title>
                  <ContentPanel.Subtitle>Folder metadata from current document tree</ContentPanel.Subtitle>
                </div>
              </ContentPanel.Header>
              <ContentPanel.Body>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>Direct child files: <strong>{stats.childFiles.length}</strong></div>
                  <div>Direct child folders: <strong>{stats.childFolders.length}</strong></div>
                  <div>Total descendant files: <strong>{stats.descendantFileCount}</strong></div>
                  <div>Total descendant folders: <strong>{stats.descendantFolderCount}</strong></div>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-text-secondary">Child files</h3>
                    {stats.childFiles.length === 0 ? (
                      <p className="text-xs text-text-muted">No child files.</p>
                    ) : (
                      <ul className="m-0 list-disc pl-4 text-xs text-text-secondary">
                        {stats.childFiles.map((path) => (
                          <li key={path}>
                            <button
                              type="button"
                              className="cursor-pointer border-none bg-transparent p-0 text-left text-accent-text hover:underline"
                              onClick={() => navigate(`/docs/${stripLeadingSlashForRoute(path)}`)}
                            >
                              {getDisplayName(path)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-text-secondary">Child folders</h3>
                    {stats.childFolders.length === 0 ? (
                      <p className="text-xs text-text-muted">No child folders.</p>
                    ) : (
                      <ul className="m-0 list-disc pl-4 text-xs text-text-secondary">
                        {stats.childFolders.map((path) => (
                          <li key={path}>
                            <button
                              type="button"
                              className="cursor-pointer border-none bg-transparent p-0 text-left text-accent-text hover:underline"
                              onClick={() => navigate(`/docs/${stripLeadingSlashForRoute(path)}`)}
                            >
                              {getDisplayName(path)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </ContentPanel.Body>
            </ContentPanel>

            <ContentPanel>
              <ContentPanel.Header>
                <ContentPanel.Title icon={<span className="opacity-60">+</span>}>
                  Create new file in this folder
                </ContentPanel.Title>
              </ContentPanel.Header>
              <ContentPanel.Body>
                <form onSubmit={handleCreateEmptyFile} className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={newFileName}
                    onChange={(event) => setNewFileName(event.target.value)}
                    placeholder="new-file-name"
                    className="input-field min-w-[280px] flex-1 text-sm"
                    disabled={creatingNewFile}
                  />
                  <button type="submit" className="btn-primary text-xs" disabled={creatingNewFile}>
                    {creatingNewFile ? "Creating..." : "Create"}
                  </button>
                </form>
                {newFileError ? <p className="mt-2 text-xs text-status-red">{newFileError}</p> : null}
              </ContentPanel.Body>
            </ContentPanel>

            <ContentPanel>
              <ContentPanel.Header>
                <ContentPanel.Title icon={<span className="opacity-60">&#9998;</span>}>
                  Create new file in this folder from text content
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
