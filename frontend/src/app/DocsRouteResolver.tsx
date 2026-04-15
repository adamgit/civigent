import { useEffect, useMemo, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { apiClient } from "../services/api-client";
import { DocsBrowserPage } from "../pages/DocsBrowserPage";
import { DocumentPage } from "../pages/DocumentPage";
import { FolderPage } from "../pages/FolderPage";
import { GovernanceDocumentPage } from "../pages/GovernanceDocumentPage";
import type { GovernanceMode } from "../types/shared.js";
import { resolveDocsSubroute } from "./docsRouteUtils";
import type { AppLayoutOutletContext } from "./AppLayout";

export type DocViewMode = "standard" | "governance";

function ViewModeToggle({ viewMode, onChange }: { viewMode: DocViewMode; onChange: (mode: DocViewMode) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-[#f5f2ed] rounded p-0.5 text-[11px]">
      <button
        onClick={() => onChange("standard")}
        className={`px-2 py-0.5 rounded transition-all ${
          viewMode === "standard"
            ? "bg-white text-text-primary shadow-sm font-medium"
            : "text-text-muted hover:text-text-primary"
        }`}
      >
        Standard
      </button>
      <button
        onClick={() => onChange("governance")}
        className={`px-2 py-0.5 rounded transition-all ${
          viewMode === "governance"
            ? "bg-white text-text-primary shadow-sm font-medium"
            : "text-text-muted hover:text-text-primary"
        }`}
      >
        Governance
      </button>
    </div>
  );
}

export function DocsRouteResolver() {
  const params = useParams();
  const { entries, treeLoading } = useOutletContext<AppLayoutOutletContext>();
  const resolved = useMemo(() => resolveDocsSubroute(params["*"]), [params]);
  const [viewMode, setViewMode] = useState<DocViewMode>("standard");
  const [governanceMode, setGovernanceMode] = useState<GovernanceMode>("available");
  const resolvedEntryType = useMemo(() => {
    if (!resolved.docPath) {
      return null;
    }
    const stack = [...entries];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      if (node.path === resolved.docPath) {
        return node.type;
      }
      if (node.type === "directory" && Array.isArray(node.children)) {
        stack.push(...node.children);
      }
    }
    return null;
  }, [entries, resolved.docPath]);

  // Fetch governance_mode from admin config on mount
  useEffect(() => {
    apiClient.getAdminConfig().then((config) => {
      setGovernanceMode(config.governance_mode ?? "available");
    }).catch(() => { /* non-fatal */ });
  }, []);

  if (!resolved.docPath) {
    return <DocsBrowserPage />;
  }

  if (resolvedEntryType === "directory") {
    return <FolderPage folderPath={resolved.docPath} />;
  }

  if (treeLoading && resolvedEntryType === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-muted">
        Resolving path...
      </div>
    );
  }

  // When forced, always render governance page with no toggle
  if (governanceMode === "forced") {
    return <GovernanceDocumentPage key={resolved.docPath} docPathOverride={resolved.docPath} />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* View mode toggle bar */}
      <div className="flex items-center justify-end px-3 py-1 bg-topbar-bg border-b border-topbar-border">
        <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
      </div>
      {/* Page content */}
      <div className="flex-1 min-h-0">
        {viewMode === "governance" ? (
          <GovernanceDocumentPage key={resolved.docPath} docPathOverride={resolved.docPath} />
        ) : (
          <DocumentPage key={resolved.docPath} docPathOverride={resolved.docPath} />
        )}
      </div>
    </div>
  );
}
