import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { apiClient } from "../services/api-client";
import { DocsBrowserPage } from "../pages/DocsBrowserPage";
import { DocumentPage } from "../pages/DocumentPage";
import { FolderPage } from "../pages/FolderPage";
import { GovernanceDocumentPage } from "../pages/GovernanceDocumentPage";
import { AgentDocumentPage } from "../pages/AgentDocumentPage";
import type { GovernanceMode } from "../types/shared.js";
import { DocsLocation } from "./docs-location";

export type DocViewMode = "standard" | "governance" | "agent";

export function ViewModeToggle({ viewMode, onChange }: { viewMode: DocViewMode; onChange: (mode: DocViewMode) => void }) {
  // Compact segmented control sized for the 46px document topbar.
  return (
    <div
      className="flex items-center gap-px bg-[#f5f2ed] rounded p-px text-[10px] leading-none shrink-0"
      role="group"
      aria-label="Document view mode"
    >
      <button
        type="button"
        onClick={() => onChange("standard")}
        className={`px-1.5 py-[3px] rounded-sm transition-all ${
          viewMode === "standard"
            ? "bg-white text-text-primary shadow-sm font-medium"
            : "text-text-muted hover:text-text-primary"
        }`}
      >
        Standard
      </button>
      <button
        type="button"
        onClick={() => onChange("governance")}
        className={`px-1.5 py-[3px] rounded-sm transition-all ${
          viewMode === "governance"
            ? "bg-white text-text-primary shadow-sm font-medium"
            : "text-text-muted hover:text-text-primary"
        }`}
      >
        Governance
      </button>
      <button
        type="button"
        onClick={() => onChange("agent")}
        className={`px-1.5 py-[3px] rounded-sm transition-all ${
          viewMode === "agent"
            ? "bg-white text-text-primary shadow-sm font-medium"
            : "text-text-muted hover:text-text-primary"
        }`}
      >
        Agent
      </button>
    </div>
  );
}

export function DocsRouteResolver() {
  const location = useLocation();
  const loc = useMemo(() => DocsLocation.fromPathname(location.pathname), [location.pathname]);
  const [viewMode, setViewMode] = useState<DocViewMode>("standard");
  const [governanceMode, setGovernanceMode] = useState<GovernanceMode>("available");

  // Fetch governance_mode from admin config on mount
  useEffect(() => {
    apiClient.getAdminConfig().then((config) => {
      setGovernanceMode(config.governance_mode ?? "available");
    }).catch(() => { /* non-fatal */ });
  }, []);

  if (loc === null || loc.kind === "index") {
    return <DocsBrowserPage />;
  }

  if (loc.kind === "folder") {
    return <FolderPage folderPath={loc.folderPath} />;
  }

  if (loc.kind === "invalid") {
    return (
      <div className="flex-1 overflow-auto p-4" style={{ fontFamily: "var(--font-ui)" }}>
        <p className="text-xs text-status-red">Not a valid document or folder URL: {loc.reason}</p>
        <p className="text-xs text-status-red">
          <code>{loc.raw}</code>
        </p>
      </div>
    );
  }

  const docPath = loc.docPath;

  // When forced, always render governance page with no toggle
  if (governanceMode === "forced") {
    return <GovernanceDocumentPage key={docPath} docPath={docPath} />;
  }

  const toolbarAccessory: ReactNode = (
    <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
  );

  if (viewMode === "governance") {
    return (
      <GovernanceDocumentPage
        key={docPath}
        docPath={docPath}
        toolbarAccessory={toolbarAccessory}
      />
    );
  }

  if (viewMode === "agent") {
    return (
      <AgentDocumentPage
        key={docPath}
        docPath={docPath}
        toolbarAccessory={toolbarAccessory}
      />
    );
  }

  return (
    <DocumentPage
      key={docPath}
      docPath={docPath}
      toolbarAccessory={toolbarAccessory}
    />
  );
}
