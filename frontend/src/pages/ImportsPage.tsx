import { useCallback, useEffect, useRef, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import {
  apiClient,
  type ImportStagingInfo,
  type ImportDetailResponse,
  type ImportStagingFile,
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
  const [commitResult, setCommitResult] = useState<string | null>(null);
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
        const files: { name: string; content: string }[] = [];
        for (const file of Array.from(fileList)) {
          if (!file.name.toLowerCase().endsWith(".md")) continue;
          const content = await file.text();
          files.push({ name: file.webkitRelativePath || file.name, content });
        }
        if (files.length === 0) {
          setError("No .md files selected.");
          return;
        }
        await apiClient.uploadImportFiles(importId, files);
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
      const res = await apiClient.commitImport(importId, description);
      setCommitResult(
        res.status === "committed"
          ? `Committed (${res.created_documents?.length ?? 0} docs created)`
          : `Proposal ${res.proposal_id} is pending review`,
      );
      onCommitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }, [importId, description, onCommitted]);

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

  const mdCount = detail?.files.filter((f) => f.is_markdown).length ?? 0;
  const totalSections = detail?.files.reduce((sum, f) => sum + f.section_count, 0) ?? 0;

  return (
    <div className="p-4 space-y-4 border-t border-border-subtle">
      {error && (
        <div className="p-2 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded text-sm">
          {error}
        </div>
      )}
      {commitResult && (
        <div className="p-2 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded text-sm">
          {commitResult}
        </div>
      )}

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
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1">File</th>
              <th className="py-1 w-16 text-center">Type</th>
              <th className="py-1 w-20 text-right">Sections</th>
            </tr>
          </thead>
          <tbody>
            {detail.files.map((f) => (
              <tr key={f.path} className="border-t border-border-subtle">
                <td className="py-1 font-mono text-xs">{f.path}</td>
                <td className="py-1 text-center">{f.is_markdown ? "\u2713" : "\u2717"}</td>
                <td className="py-1 text-right">{f.is_markdown ? f.section_count : "\u2014"}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
          className="px-4 py-1.5 bg-accent-emphasis text-white rounded text-sm disabled:opacity-50"
          disabled={!description.trim() || committing || mdCount === 0}
          onClick={handleCommit}
        >
          {committing ? "Importing..." : "Import"}
        </button>
        <button
          className="px-4 py-1.5 bg-canvas-subtle border border-border-default rounded text-sm"
          onClick={fetchDetail}
        >
          Refresh
        </button>
        <button
          className="px-4 py-1.5 text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 rounded text-sm ml-auto"
          onClick={handleDelete}
        >
          Cancel
        </button>
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
        {error && (
          <div className="mb-4 p-2 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded text-sm">
            {error}
          </div>
        )}

        <div className="mb-4">
          <button
            className="px-4 py-2 bg-accent-emphasis text-white rounded text-sm"
            onClick={handleNewImport}
          >
            + New Import
          </button>
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
                  {new Date(imp.created_at).toLocaleString()}
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
