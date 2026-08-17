import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import {
  apiClient,
  type ImportStagingInfo,
  type ImportDetailResponse,
  type ImportResponse,
  type ImportStagingFile,
  type ImportDuplicateBodyConflict,
  type ImportCommitProgress,
} from "../services/api-client";
import type { DocumentTreeEntry } from "../types/shared.js";
import { FolderPath } from "../types/shared.js";
import { folderHref } from "../app/docs-location";

function joinedImportDocPath(targetFolder: string, relativePath: string): string {
  return targetFolder === "/" ? `/${relativePath}` : `${targetFolder}/${relativePath}`;
}

function filterSupportedImportFiles(fileList: FileList): { files: File[]; skippedNotice: string | null } {
  const all = Array.from(fileList);
  const files = all.filter((file) => {
    const name = file.name.toLowerCase();
    return name.endsWith(".md") || name.endsWith(".zip");
  });
  const skipped = all.length - files.length;
  return {
    files,
    skippedNotice:
      skipped > 0 ? `Skipped ${skipped} unsupported file(s) — only .md and .zip can be imported.` : null,
  };
}

async function uploadFilesToImport(importId: string, files: File[]): Promise<void> {
  const zipFiles = files.filter((file) => file.name.toLowerCase().endsWith(".zip"));
  const mdFiles = files.filter((file) => file.name.toLowerCase().endsWith(".md"));
  for (const zipFile of zipFiles) {
    await apiClient.uploadImportZip(importId, zipFile);
  }
  const BATCH_SIZE = 5;
  for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
    await apiClient.uploadImportFiles(importId, mdFiles.slice(i, i + BATCH_SIZE));
  }
}

function destinationLabel(folder: string): string {
  return folder === "/" ? "/ (workspace root)" : folder;
}

function bindDirectoryPicker(input: HTMLInputElement | null): void {
  if (!input) return;
  input.setAttribute("webkitdirectory", "");
  input.setAttribute("directory", "");
}

function ImportSourceDropZone({
  uploading,
  hint,
  onFiles,
}: {
  uploading: boolean;
  hint: string;
  onFiles: (files: FileList) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bindDirectoryPicker(folderInputRef.current);
  }, []);

  const takeFiles = (list: FileList | null, input: HTMLInputElement | null) => {
    if (list && list.length > 0) onFiles(list);
    if (input) input.value = "";
  };

  return (
    <div
      className="border-2 border-dashed border-border-subtle rounded-lg p-6 text-center hover:border-accent-emphasis transition-colors"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        takeFiles(e.dataTransfer.files, null);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.zip"
        className="hidden"
        onChange={(e) => takeFiles(e.target.files, e.target)}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => takeFiles(e.target.files, e.target)}
      />
      <p className="text-sm text-muted">{uploading ? "Uploading..." : hint}</p>
      <div className="mt-3 flex justify-center gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          Choose files
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={uploading}
          onClick={() => folderInputRef.current?.click()}
        >
          Choose folder
        </button>
      </div>
    </div>
  );
}

function ImportDestinationCallout({
  folder,
  size,
}: {
  folder: string;
  size: "hero" | "row";
}) {
  const label = destinationLabel(folder);
  if (size === "hero") {
    return (
      <div className="w-fit max-w-md rounded-md border border-folder-card-border bg-folder-card-bg px-3.5 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          New imports will land in
        </div>
        <div className="mt-1 font-mono text-sm font-semibold text-text-primary break-all">
          {label}
        </div>
        <p className="mt-2 mb-0 text-[13px] leading-snug text-text-secondary">
          To import into a different folder, click the ↑ import button next to
          that folder in the sidebar.
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">In-progress import</div>
      <div className="mt-0.5 text-sm">
        Importing into <span className="font-mono font-semibold break-all">{label}</span>
      </div>
    </div>
  );
}

function headingChoiceKey(headingPath: string[]): string {
  return JSON.stringify(headingPath);
}

function DuplicateBodyConflictModal({
  filePath,
  conflicts,
  selections,
  applying,
  error,
  onChange,
  onCancel,
  onConfirm,
}: {
  filePath: string;
  conflicts: ImportDuplicateBodyConflict[];
  selections: Record<string, number>;
  applying: boolean;
  error: string | null;
  onChange: (headingPath: string[], index: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={applying ? undefined : onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-conflict-title"
        className="relative bg-canvas-bg border border-border-default rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto p-5"
      >
        <h2 id="import-conflict-title" className="text-lg font-semibold">
          Choose which duplicate body to keep
        </h2>
        <p className="text-xs text-muted mt-1 mb-4">
          This file has the same heading more than once, with different text.
          Pick one copy per heading. The others will be dropped.
        </p>
        <p className="font-mono text-xs mb-4 break-all">{filePath}</p>
        {conflicts.map((conflict) => {
          const key = headingChoiceKey(conflict.heading_path);
          const selected = selections[key] ?? 0;
          return (
            <div key={key} className="mb-4">
              <div className="text-sm font-medium mb-2">{conflict.label}</div>
              <div className="flex flex-col gap-2">
                {conflict.copies.map((copy) => {
                  const isLast = copy.index === conflict.copies.length - 1;
                  const position =
                    copy.index === 0 ? " (earlier in file)" : isLast ? " (later in file)" : "";
                  return (
                    <label
                      key={copy.index}
                      className={`block border rounded p-2 cursor-pointer ${
                        selected === copy.index
                          ? "border-accent-emphasis bg-accent-light"
                          : "border-border-default bg-page-bg"
                      }`}
                    >
                      <div className="flex items-center gap-2 text-xs font-medium mb-1">
                        <input
                          type="radio"
                          name={key}
                          checked={selected === copy.index}
                          onChange={() => onChange(conflict.heading_path, copy.index)}
                          disabled={applying}
                        />
                        Copy {copy.index + 1}{position}
                      </div>
                      <pre className="text-xs font-mono whitespace-pre-wrap max-h-48 overflow-auto bg-white p-2 rounded">
                        {copy.body.trim().length > 0 ? copy.body : "(empty)"}
                      </pre>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
        {error && <p className="text-error text-sm break-words mt-2">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={applying}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm} disabled={applying}>
            {applying ? "Applying..." : "Keep selected"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportFileTable({
  children,
  columns,
}: {
  children: ReactNode;
  columns: ReactNode;
}) {
  return (
    <div className="max-h-80 overflow-auto border border-border-subtle rounded">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-canvas-default">
          <tr className="text-left text-xs text-muted">
            {columns}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function ImportDetailView({
  importId,
  onDelete,
  onCommitted,
}: {
  importId: string;
  onDelete: () => void;
  onCommitted: () => void;
}) {
  const [detail, setDetail] = useState<ImportDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitProgress, setCommitProgress] = useState<ImportCommitProgress | null>(null);
  const [commitResult, setCommitResult] = useState<ImportResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [skippedNotice, setSkippedNotice] = useState<string | null>(null);
  const [existingDocPaths, setExistingDocPaths] = useState<ReadonlySet<string>>(new Set());
  const [selectedResolutions, setSelectedResolutions] = useState<Record<string, string>>({});
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);
  const [conflictModal, setConflictModal] = useState<{
    file: ImportStagingFile;
    resolutionId: string;
    conflicts: ImportDuplicateBodyConflict[];
    selections: Record<string, number>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getWorkspaceTree()
      .then((res) => {
        if (cancelled) return;
        const paths = new Set<string>();
        const walk = (nodes: DocumentTreeEntry[]) => {
          for (const node of nodes) {
            if (node.type === "file") paths.add(node.path);
            else if (node.children) walk(node.children);
          }
        };
        walk(res.tree);
        setExistingDocPaths(paths);
      })
      .catch(() => { /* non-fatal background fetch */ });
    return () => {
      cancelled = true;
    };
  }, [importId]);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getImportDetail(importId);
      setDetail(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [importId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  useEffect(() => {
    if (!detail) return;
    setSelectedResolutions((prev) => {
      const next = { ...prev };
      for (const file of detail.files) {
        if (!next[file.path] && file.applicable_resolutions[0]) {
          next[file.path] = file.applicable_resolutions[0].id;
        }
      }
      return next;
    });
  }, [detail]);

  const handleUpload = useCallback(
    async (fileList: FileList) => {
      setUploading(true);
      setError(null);
      try {
        const { files, skippedNotice: notice } = filterSupportedImportFiles(fileList);
        setSkippedNotice(notice);
        if (files.length === 0) {
          if (!notice) setError("No .md or .zip files selected.");
          return;
        }

        await uploadFilesToImport(importId, files);
        await fetchDetail();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [importId, fetchDetail],
  );

  const handleCommit = useCallback(async () => {
    setCommitting(true);
    setError(null);
    setCommitResult(null);
    try {
      const res = await apiClient.commitImport(importId, description, setCommitProgress);
      setCommitResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
      setCommitProgress(null);
    }
  }, [importId, description]);

  const handleResolve = useCallback(
    async (file: ImportStagingFile) => {
      const resolution = selectedResolutions[file.path] ?? file.applicable_resolutions[0]?.id;
      if (!resolution) return;
      const option = file.applicable_resolutions.find((entry) => entry.id === resolution);
      const conflicts = option?.preview?.conflicts;
      if (conflicts && conflicts.length > 0) {
        const selections: Record<string, number> = {};
        for (const conflict of conflicts) {
          selections[headingChoiceKey(conflict.heading_path)] = 0;
        }
        setConflictModal({ file, resolutionId: resolution, conflicts, selections });
        return;
      }
      setResolvingPath(file.path);
      setError(null);
      try {
        const res = await apiClient.resolveImportFile(importId, file.path, resolution);
        setDetail(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setResolvingPath(null);
      }
    },
    [importId, selectedResolutions],
  );

  const handleConflictConfirm = useCallback(async () => {
    if (!conflictModal) return;
    const keep = conflictModal.conflicts.map((conflict) => ({
      heading_path: conflict.heading_path,
      index: conflictModal.selections[headingChoiceKey(conflict.heading_path)] ?? 0,
    }));
    setResolvingPath(conflictModal.file.path);
    setError(null);
    try {
      const res = await apiClient.resolveImportFile(
        importId,
        conflictModal.file.path,
        conflictModal.resolutionId,
        { keep },
      );
      setDetail(res);
      setConflictModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingPath(null);
    }
  }, [importId, conflictModal]);

  const handleDelete = useCallback(async () => {
    if (!confirm("Delete this import? Files in the staging folder will be removed.")) return;
    try {
      await apiClient.deleteImport(importId);
      onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [importId, onDelete]);

  if (loading) return <div className="p-4 text-sm text-muted">Scanning staging folder...</div>;

  // ── Result view after commit ──
  if (commitResult) {
    const isCommitted = commitResult.status === "committed" && commitResult.outcome === "accepted";
    const policyTargets = commitResult.agentWritePolicy?.targets ?? [];
    const blockedCount = policyTargets.filter((t) => !t.canWrite).length;
    const sectionCount = policyTargets.length;
    const docPaths = [...new Set(policyTargets.map((t) => t.target.doc_path))];

    return (
      <div className="p-4 space-y-3 border-t border-border-subtle">
        <div className={`p-3 rounded text-sm ${isCommitted
          ? "bg-status-green-light text-status-green"
          : "bg-status-yellow-light text-status-yellow"}`}
        >
          <div className="font-medium mb-1">
            {isCommitted ? "Import committed" : "Import pending review"}
          </div>
          <div className="text-xs space-y-0.5">
            <div>Proposal: <code>{commitResult.proposal_id}</code></div>
            <div>Status: {commitResult.status} / {commitResult.outcome}</div>
            {(commitResult as unknown as { committed_head?: string }).committed_head && (
              <div>Commit: <code>{(commitResult as unknown as { committed_head?: string }).committed_head!.slice(0, 10)}</code></div>
            )}
            <div>Sections: {sectionCount}</div>
            {docPaths.length > 0 && <div>Documents: {docPaths.join(", ")}</div>}
            {blockedCount > 0 && (
              <div className="text-error">
                {/* Area M: backend prose is the explanation, not a code. */}
                {blockedCount} section(s) blocked. {commitResult.agentWritePolicy?.message}
              </div>
            )}
          </div>
        </div>
        {Array.isArray((commitResult as unknown as { diagnostics?: string[] }).diagnostics) &&
          (commitResult as unknown as { diagnostics?: string[] }).diagnostics!.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">Diagnostics</summary>
            <pre className="mt-1 p-2 bg-canvas-subtle rounded overflow-x-auto text-xs">
              {(commitResult as unknown as { diagnostics?: string[] }).diagnostics!.join("\n")}
            </pre>
          </details>
        )}
        <button className="btn-secondary" onClick={onCommitted}>Done</button>
      </div>
    );
  }

  const importableFiles = detail?.files.filter((f) => f.is_markdown && f.rejection_reason === null) ?? [];
  const excludedFiles = detail?.files.filter((f) => f.rejection_reason !== null) ?? [];
  const totalSections = importableFiles.reduce((sum, f) => sum + f.section_count, 0);
  const overwriteCount = detail
    ? importableFiles.filter((f) => existingDocPaths.has(joinedImportDocPath(detail.target_folder, f.path))).length
    : 0;
  const newDocCount = importableFiles.length - overwriteCount;

  return (
    <div className="p-4 space-y-4 border-t border-border-subtle">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>Staging path:</span>
        <code className="bg-canvas-subtle px-1 py-0.5 rounded select-all">
          {detail?.staging_path}
        </code>
      </div>

      <div className="text-sm text-muted">
        {importableFiles.length} document{importableFiles.length !== 1 ? "s" : ""} will be imported
        {totalSections > 0 && `, ${totalSections} section${totalSections !== 1 ? "s" : ""}`}
        {excludedFiles.length > 0 && `, ${excludedFiles.length} excluded`}
      </div>

      {detail && importableFiles.length > 0 && (
        <ImportFileTable
          columns={
            <>
              <th className="py-1 px-2">Document</th>
              <th className="py-1 w-16 text-center">Type</th>
              <th className="py-1 w-20 text-right px-2">Sections</th>
            </>
          }
        >
          {importableFiles.map((f) => {
            const targetDocPath = joinedImportDocPath(detail.target_folder, f.path);
            const willOverwrite = existingDocPaths.has(targetDocPath);
            return (
              <tr key={f.path} className="border-t border-border-subtle">
                <td className="py-1 px-2 font-mono text-xs whitespace-nowrap">
                  {targetDocPath}
                  {willOverwrite && (
                    <span className="ml-2 font-sans text-amber-600 dark:text-amber-400">will overwrite</span>
                  )}
                </td>
                <td className="py-1 text-center">{"\u2713"}</td>
                <td className="py-1 text-right px-2">{f.section_count}</td>
              </tr>
            );
          })}
        </ImportFileTable>
      )}

      {detail && excludedFiles.length > 0 && (
        <div className="rounded-lg border-2 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 space-y-2">
          <div>
            <div className="text-sm font-semibold text-red-700 dark:text-red-400">
              Excluded from import ({excludedFiles.length})
            </div>
            <p className="text-xs text-red-700/80 dark:text-red-400/80 mt-0.5">
              These files will not be imported. Choose a repair where one is offered, or leave them excluded.
            </p>
          </div>
          <ImportFileTable
            columns={
              <>
                <th className="py-1 px-2">Document</th>
                <th className="py-1 px-2">Why excluded</th>
                <th className="py-1 px-2 w-[18rem]">Repair</th>
              </>
            }
          >
            {excludedFiles.map((f) => {
              const resolutions = f.applicable_resolutions ?? [];
              const selected = selectedResolutions[f.path] ?? resolutions[0]?.id ?? "";
              return (
                <tr key={f.path} className="border-t border-border-subtle text-red-800 dark:text-red-300">
                  <td className="py-1 px-2 font-mono text-xs whitespace-nowrap align-top">{f.path}</td>
                  <td className="py-1 px-2 text-xs align-top">{f.rejection_reason}</td>
                  <td className="py-1 px-2 align-top">
                    {resolutions.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        <select
                          className="w-full text-xs px-1 py-1 border border-border-default rounded bg-canvas-default"
                          value={selected}
                          onChange={(e) =>
                            setSelectedResolutions((prev) => ({ ...prev, [f.path]: e.target.value }))
                          }
                          disabled={resolvingPath === f.path}
                        >
                          {resolutions.map((resolution) => (
                            <option key={resolution.id} value={resolution.id}>
                              {resolution.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn-secondary self-start"
                          disabled={resolvingPath === f.path || !selected}
                          onClick={() => handleResolve(f)}
                        >
                          {resolvingPath === f.path ? "Applying..." : "Apply"}
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted">No automatic repair</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </ImportFileTable>
        </div>
      )}

      <ImportSourceDropZone
        uploading={uploading}
        hint="Drop markdown, a zip, or a folder of markdown"
        onFiles={handleUpload}
      />

      {skippedNotice && <p className="text-xs text-amber-600 dark:text-amber-400">{skippedNotice}</p>}

      <div className="space-y-2">
        <label className="block text-sm font-medium">
          Description <span className="text-red-500">*</span>
        </label>
        <p className="text-xs text-muted">
          Required because the import is recorded as a proposal. This text is the
          proposal intent and the git commit message for what landed — without it
          there is no explanation in history of why these documents appeared.
        </p>
        <textarea
          className="w-full px-3 py-2 border border-border-default rounded bg-canvas-default text-sm"
          rows={3}
          placeholder="Describe what is being imported and why..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {error && <p className="text-error text-sm break-words">{error}</p>}

      <div className="flex gap-2">
        <button
          className="btn-primary"
          style={{ opacity: (!description.trim() || committing || importableFiles.length === 0) ? 0.5 : 1 }}
          disabled={!description.trim() || committing || importableFiles.length === 0}
          onClick={handleCommit}
        >
          {committing ? "Importing..." : "Import"}
        </button>
        {importableFiles.length > 0 && (
          <span className="self-center text-xs text-muted">
            {newDocCount} new document{newDocCount !== 1 ? "s" : ""}
            {overwriteCount > 0 &&
              `, ${overwriteCount} will replace existing document${overwriteCount !== 1 ? "s" : ""}`}
            {excludedFiles.length > 0 && `, ${excludedFiles.length} excluded`}
          </span>
        )}
        <button className="btn-secondary" onClick={fetchDetail}>Refresh</button>
        <button className="btn-danger" style={{ marginLeft: "auto" }} onClick={handleDelete}>Cancel</button>
      </div>

      {committing && (
        <div className="space-y-1">
          {commitProgress && "publishing" in commitProgress ? (
            <>
              <div className="h-2 rounded bg-page-bg border border-border-default overflow-hidden">
                <div className="h-full w-full bg-accent animate-pulse" />
              </div>
              <p className="text-xs text-muted">Publishing…</p>
            </>
          ) : (
            <>
              <div className="h-2 rounded bg-page-bg border border-border-default overflow-hidden">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{
                    width: commitProgress
                      ? `${Math.round((commitProgress.index / commitProgress.total) * 100)}%`
                      : "0%",
                  }}
                />
              </div>
              <p className="text-xs text-muted">
                {commitProgress
                  ? `${commitProgress.index} of ${commitProgress.total} — ${commitProgress.docPath}`
                  : "Starting…"}
              </p>
            </>
          )}
        </div>
      )}

      {conflictModal && (
        <DuplicateBodyConflictModal
          filePath={conflictModal.file.path}
          conflicts={conflictModal.conflicts}
          selections={conflictModal.selections}
          applying={resolvingPath === conflictModal.file.path}
          error={error}
          onChange={(headingPath, index) => {
            setConflictModal((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                selections: { ...prev.selections, [headingChoiceKey(headingPath)]: index },
              };
            });
          }}
          onCancel={() => {
            if (resolvingPath) return;
            setConflictModal(null);
          }}
          onConfirm={() => {
            void handleConflictConfirm();
          }}
        />
      )}
    </div>
  );
}

export function ImportsPage() {
  const [searchParams] = useSearchParams();
  const intoFolder = searchParams.get("into")?.trim() || "/";
  const [imports, setImports] = useState<ImportStagingInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(() => searchParams.get("expand"));
  const [pageSkippedNotice, setPageSkippedNotice] = useState<string | null>(null);
  const [pageUploading, setPageUploading] = useState(false);

  const fetchImports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getImports();
      setImports(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchImports();
  }, [fetchImports]);

  const handleNewImport = useCallback(async () => {
    try {
      const res = await apiClient.createImport(intoFolder);
      setImports((prev) => [res, ...prev]);
      setExpandedId(res.import_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [intoFolder]);

  const handlePageFiles = useCallback(
    async (fileList: FileList) => {
      const { files, skippedNotice } = filterSupportedImportFiles(fileList);
      setPageSkippedNotice(skippedNotice);
      if (files.length === 0) return;
      setPageUploading(true);
      setError(null);
      try {
        const res = await apiClient.createImport(intoFolder);
        await uploadFilesToImport(res.import_id, files);
        setImports((prev) => [res, ...prev]);
        setExpandedId(res.import_id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPageUploading(false);
      }
    },
    [intoFolder],
  );

  const intoFolderPath = FolderPath.tryParse(intoFolder);
  const backTo = intoFolderPath && intoFolderPath !== FolderPath.root ? folderHref(intoFolderPath) : "/";

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Imports" backTo={backTo} />
      <div className="flex-1 overflow-y-auto p-6">
        {error && <p className="text-error mb-4">{error}</p>}

        {expandedId === null && (
          <div className="mb-4">
            <ImportDestinationCallout folder={intoFolder} size="hero" />
          </div>
        )}

        <div className="mb-4 flex items-center gap-3">
          <button className="btn-primary" onClick={handleNewImport}>+ New Import</button>
          <Link to="/export" className="text-xs text-muted hover:text-accent">
            Advanced Export
          </Link>
        </div>

        {expandedId === null && (
          <div className="mb-4 space-y-1">
            <ImportSourceDropZone
              uploading={pageUploading}
              hint={`Drop markdown, a zip, or a folder of markdown to start an import into ${destinationLabel(intoFolder)}`}
              onFiles={(files) => {
                void handlePageFiles(files);
              }}
            />
            {pageSkippedNotice && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{pageSkippedNotice}</p>
            )}
          </div>
        )}

        {loading && imports.length === 0 && (
          <div className="text-sm text-muted">Loading...</div>
        )}

        {!loading && imports.length === 0 && (
          <div className="text-sm text-muted">
            No in-progress imports. Click "New Import" to create a staging folder.
          </div>
        )}

        <div className="space-y-2">
          {imports.map((imp) => (
            <div
              key={imp.import_id}
              className="border border-border-default rounded bg-canvas-default"
            >
              <div
                className="flex items-start justify-between gap-4 px-4 py-3 cursor-pointer hover:bg-canvas-subtle"
                onClick={() =>
                  setExpandedId((prev) =>
                    prev === imp.import_id ? null : imp.import_id,
                  )
                }
              >
                <ImportDestinationCallout folder={imp.target_folder} size="row" />
                <code className="text-xs font-mono text-muted select-all break-all text-right">
                  {imp.import_id}
                </code>
              </div>
              {expandedId === imp.import_id && (
                <ImportDetailView
                  importId={imp.import_id}
                  onDelete={() => {
                    setImports((prev) =>
                      prev.filter((i) => i.import_id !== imp.import_id),
                    );
                    setExpandedId(null);
                  }}
                  onCommitted={() => {
                    fetchImports();
                    setExpandedId(null);
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
