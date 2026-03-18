import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { apiClient } from "../services/api-client";
import { DocsBrowserPage } from "../pages/DocsBrowserPage";
import { DocumentPage } from "../pages/DocumentPage";
import { GovernanceDocumentPage } from "../pages/GovernanceDocumentPage";
import type { GovernanceMode } from "../types/shared.js";
import { resolveDocsSubroute } from "./docsRouteUtils";

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
  const resolved = useMemo(() => resolveDocsSubroute(params["*"]), [params]);
  const [viewMode, setViewMode] = useState<DocViewMode>("standard");
  const [governanceMode, setGovernanceMode] = useState<GovernanceMode>("available");

  // Fetch governance_mode from admin config on mount
  useEffect(() => {
    apiClient.getAdminConfig().then((config) => {
      setGovernanceMode(config.governance_mode ?? "available");
    }).catch(() => { /* non-fatal */ });
  }, []);

  if (!resolved.docPath) {
    return <DocsBrowserPage />;
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
