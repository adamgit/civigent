import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import {
  apiClient,
  type ImportStagingInfo,
  type ImportDetailResponse,
  type ImportResponse,
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
  const [commitResult, setCommitResult] = useState<ImportResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [skippedNotice, setSkippedNotice] = useState<string | null>(null);
  const [existingDocPaths, setExistingDocPaths] = useState<ReadonlySet<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

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
    const hasArtifacts = (detail?.files ?? []).some((f) => f.is_internal_artifact);
    if (hasArtifacts) {
      alert(
        "Civigent internal-format files detected — import cannot continue, these files will corrupt on import.\n\nYou probably meant to copy from the snapshots folder instead?"
      );
      return;
    }
    setCommitting(true);
    setError(null);
    setCommitResult(null);
    try {
      const res = await apiClient.commitImport(importId, description);
      setCommitResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }, [importId, description, detail, onCommitted]);

  const handleDelete = useCallback(async () => {
    if (!confirm("Delete this import? Files in the staging folder will be removed.")) return;
    try {
      await apiClient.deleteImport(importId);
      onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [importId, onDelete]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer.files.length > 0) {
        handleUpload(e.dataTransfer.files);
      }
    },
    [handleUpload],
  );

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

  const mdCount = detail?.files.filter((f) => f.is_markdown).length ?? 0;
  const totalSections = detail?.files.reduce((sum, f) => sum + f.section_count, 0) ?? 0;
  const artifactCount = detail?.files.filter((f) => f.is_internal_artifact).length ?? 0;
  const importableFiles = detail?.files.filter((f) => f.is_markdown && !f.is_internal_artifact) ?? [];
  const overwriteCount = detail
    ? importableFiles.filter((f) => existingDocPaths.has(joinedImportDocPath(detail.target_folder, f.path))).length
    : 0;
  const newDocCount = importableFiles.length - overwriteCount;

  return (
    <div className="p-4 space-y-4 border-t border-border-subtle">
      {error && <p className="text-error">{error}</p>}

      <div className="flex items-center gap-2 text-xs text-muted">
        <span>Staging path:</span>
        <code className="bg-canvas-subtle px-1 py-0.5 rounded select-all">
          {detail?.staging_path}
        </code>
      </div>

      <div className="text-sm text-muted">
        {mdCount} markdown file{mdCount !== 1 ? "s" : ""}, {totalSections} total section
        {totalSections !== 1 ? "s" : ""}
      </div>

      {detail && detail.files.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1">Document</th>
                <th className="py-1 w-16 text-center">Type</th>
                <th className="py-1 w-20 text-right">Sections</th>
              </tr>
            </thead>
            <tbody>
              {detail.files.map((f) => {
                const rowClass = f.is_internal_artifact
                  ? "border-t border-border-subtle text-red-600 dark:text-red-400"
                  : !f.is_markdown
                    ? "border-t border-border-subtle text-amber-600 dark:text-amber-400"
                    : "border-t border-border-subtle";
                const typeIcon = f.is_internal_artifact ? "⚠" : f.is_markdown ? "\u2713" : "\u2717";
                const isImportable = f.is_markdown && !f.is_internal_artifact;
                const targetDocPath = joinedImportDocPath(detail.target_folder, f.path);
                const willOverwrite = isImportable && existingDocPaths.has(targetDocPath);
                return (
                  <tr key={f.path} className={rowClass} title={f.rejection_reason ?? undefined}>
                    <td className="py-1 font-mono text-xs whitespace-nowrap">
                      {isImportable ? targetDocPath : f.path}
                      {willOverwrite && (
                        <span className="ml-2 font-sans text-amber-600 dark:text-amber-400">will overwrite</span>
                      )}
                    </td>
                    <td className="py-1 text-center">{typeIcon}</td>
                    <td className="py-1 text-right">{f.is_markdown && !f.is_internal_artifact ? f.section_count : "\u2014"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div
        className="border-2 border-dashed border-border-subtle rounded-lg p-6 text-center cursor-pointer hover:border-accent-emphasis transition-colors"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".md,.zip"
          className="hidden"
          onChange={(e) => e.target.files && handleUpload(e.target.files)}
        />
        <p className="text-sm text-muted">
          {uploading ? "Uploading..." : "Drop .md or .zip files here or click to browse"}
        </p>
      </div>

      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleUpload(e.target.files)}
        {...({ webkitdirectory: "" } as Record<string, string>)}
      />
      <button
        type="button"
        className="border-none bg-transparent p-0 text-xs text-muted hover:text-accent cursor-pointer"
        disabled={uploading}
        onClick={() => folderInputRef.current?.click()}
      >
        …or choose a whole folder
      </button>

      {skippedNotice && <p className="text-xs text-amber-600 dark:text-amber-400">{skippedNotice}</p>}

      <div className="space-y-2">
        <label className="block text-sm font-medium">
          Description <span className="text-red-500">*</span>
        </label>
        <textarea
          className="w-full px-3 py-2 border border-border-default rounded bg-canvas-default text-sm"
          rows={3}
          placeholder="Describe what is being imported and why..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="flex gap-2">
        <button
          className="btn-primary"
          style={{ opacity: (!description.trim() || committing || mdCount === 0) ? 0.5 : 1 }}
          disabled={!description.trim() || committing || mdCount === 0}
          onClick={handleCommit}
        >
          {committing ? "Importing..." : "Import"}
        </button>
        {importableFiles.length > 0 && (
          <span className="self-center text-xs text-muted">
            {newDocCount} new document{newDocCount !== 1 ? "s" : ""}
            {overwriteCount > 0 &&
              `, ${overwriteCount} will replace existing document${overwriteCount !== 1 ? "s" : ""}`}
          </span>
        )}
        <button className="btn-secondary" onClick={fetchDetail}>Refresh</button>
        <button className="btn-danger" style={{ marginLeft: "auto" }} onClick={handleDelete}>Cancel</button>
      </div>
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
  const pageFileInputRef = useRef<HTMLInputElement>(null);

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

        <div className="mb-4 flex items-center gap-3">
          <button className="btn-primary" onClick={handleNewImport}>+ New Import</button>
          <Link to="/export" className="text-xs text-muted hover:text-accent">
            Advanced Export
          </Link>
        </div>

        {expandedId === null && (
          <div className="mb-4 space-y-1">
            <div
              className="border-2 border-dashed border-border-subtle rounded-lg p-6 text-center cursor-pointer hover:border-accent-emphasis transition-colors"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files.length > 0) handlePageFiles(e.dataTransfer.files);
              }}
              onClick={() => pageFileInputRef.current?.click()}
            >
              <input
                ref={pageFileInputRef}
                type="file"
                multiple
                accept=".md,.zip"
                className="hidden"
                onChange={(e) => e.target.files && handlePageFiles(e.target.files)}
              />
              <p className="text-sm text-muted">
                {pageUploading
                  ? "Uploading..."
                  : `Drop .md or .zip files here to start an import into ${intoFolder}`}
              </p>
            </div>
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
                className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-canvas-subtle"
                onClick={() =>
                  setExpandedId((prev) =>
                    prev === imp.import_id ? null : imp.import_id,
                  )
                }
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-muted">
                    {imp.import_id.slice(0, 8)}...
                  </span>
                  <span className="text-xs text-muted">into</span>
                  <code className="text-xs bg-canvas-subtle px-1 py-0.5 rounded">
                    {imp.target_folder}
                  </code>
                </div>
                <span className="text-xs text-muted">
                  {imp.import_id.slice(0, 12)}
                </span>
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
