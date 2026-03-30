import { useCallback, useEffect, useRef, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import {
  apiClient,
  type ImportStagingInfo,
  type ImportDetailResponse,
  type ImportResponse,
} from "../services/api-client";

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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        const files = Array.from(fileList).filter((file) => file.name.toLowerCase().endsWith(".md"));
        if (files.length === 0) {
          setError("No .md files selected.");
          return;
        }

        const BATCH_SIZE = 5;
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          await apiClient.uploadImportFiles(importId, files.slice(i, i + BATCH_SIZE));
        }
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
    const blockedCount = commitResult.evaluation?.blocked_sections?.length ?? 0;
    const docPaths = [...new Set(commitResult.sections?.map((s) => s.doc_path) ?? [])];

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
            <div>Sections: {commitResult.sections?.length ?? 0}</div>
            {docPaths.length > 0 && <div>Documents: {docPaths.join(", ")}</div>}
            {blockedCount > 0 && (
              <div className="text-error">
                {blockedCount} section(s) blocked by human-involvement thresholds
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
                <th className="py-1">File</th>
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
                return (
                  <tr key={f.path} className={rowClass} title={f.rejection_reason ?? undefined}>
                    <td className="py-1 font-mono text-xs whitespace-nowrap">{f.path}</td>
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
          accept=".md"
          className="hidden"
          onChange={(e) => e.target.files && handleUpload(e.target.files)}
        />
        <p className="text-sm text-muted">
          {uploading ? "Uploading..." : "Drop .md files here or click to browse"}
        </p>
      </div>

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
        <button className="btn-secondary" onClick={fetchDetail}>Refresh</button>
        <button className="btn-danger" style={{ marginLeft: "auto" }} onClick={handleDelete}>Cancel</button>
      </div>
    </div>
  );
}

export function ImportsPage() {
  const [imports, setImports] = useState<ImportStagingInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
      const res = await apiClient.createImport();
      setImports((prev) => [res, ...prev]);
      setExpandedId(res.import_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="flex flex-col h-full">
      <SharedPageHeader title="Imports" backTo="/admin" />
      <div className="flex-1 overflow-y-auto p-6">
        {error && <p className="text-error mb-4">{error}</p>}

        <div className="mb-4">
          <button className="btn-primary" onClick={handleNewImport}>+ New Import</button>
        </div>

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
                  <code className="text-xs bg-canvas-subtle px-1 py-0.5 rounded">
                    {imp.staging_path}
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
