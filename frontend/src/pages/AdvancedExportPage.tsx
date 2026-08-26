import { useEffect, useMemo, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type { DocumentTreeEntry } from "../types/shared.js";

function collectFolderPaths(entries: DocumentTreeEntry[]): string[] {
  const out: string[] = [];
  const walk = (nodes: DocumentTreeEntry[]) => {
    for (const node of nodes) {
      if (node.type !== "directory") continue;
      out.push(node.path);
      if (node.children) walk(node.children);
    }
  };
  walk(entries);
  return out.sort();
}

export function AdvancedExportPage() {
  const [entries, setEntries] = useState<DocumentTreeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("/");

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getWorkspaceTree()
      .then((res) => {
        if (!cancelled) setEntries(res.tree);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const folderPaths = useMemo(() => ["/", ...collectFolderPaths(entries)], [entries]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SharedPageHeader title="Advanced Export" backTo="/imports" />
      <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
        {error && <p className="text-error">{error}</p>}

        <p className="text-sm text-muted max-w-prose">
          Download a folder as a zip whose entry paths are absolute (rooted at the content root), the
          layout used for full-workspace backups. The regular folder export uses folder-relative
          paths that re-import under any destination.
        </p>

        <div className="flex items-center gap-3">
          <label className="text-sm font-medium" htmlFor="advanced-export-folder">
            Folder
          </label>
          <select
            id="advanced-export-folder"
            className="px-2 py-1.5 border border-border-default rounded bg-canvas-default text-sm"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          >
            {folderPaths.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
          <button
            className="btn-primary"
            onClick={() => {
              window.location.href = `/api/export?path=${encodeURIComponent(folder)}&layout=absolute`;
            }}
          >
            Download
          </button>
        </div>
      </div>
    </div>
  );
}
