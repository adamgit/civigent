import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { apiClient } from "../services/api-client";
import { DocsBrowserPage } from "../pages/DocsBrowserPage";
import { DocumentPage } from "../pages/DocumentPage";
import { FolderPage } from "../pages/FolderPage";
import { GovernanceDocumentPage } from "../pages/GovernanceDocumentPage";
import { AgentDocumentPage } from "../pages/AgentDocumentPage";
import type { GovernanceMode } from "../types/shared.js";
import { resolveDocsSubroute } from "./docsRouteUtils";
import type { AppLayoutOutletContext } from "./AppLayout";

export type DocViewMode = "standard" | "governance" | "agent";

export function ViewModeToggle({ viewMode, onChange }: { viewMode: DocViewMode; onChange: (mode: DocViewMode) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-[#f5f2ed] rounded p-0.5 text-[11px] shrink-0">
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
      <button
        onClick={() => onChange("agent")}
        className={`px-2 py-0.5 rounded transition-all ${
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
  const params = useParams();
  const { entries, treeLoading } = useOutletContext<AppLayoutOutletContext>();
  const resolved = useMemo(() => resolveDocsSubroute(params["*"]), [params]);
  const [viewMode, setViewMode] = useState<DocViewMode>("standard");
  const [governanceMode, setGovernanceMode] = useState<GovernanceMode>("available");
  const routePath = resolved.docPath ?? resolved.folderPath;
  const resolvedEntryType = useMemo(() => {
    if (!routePath) {
      return null;
    }
    const stack = [...entries];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      if (node.path === routePath) {
        return node.type;
      }
      if (node.type === "directory" && Array.isArray(node.children)) {
        stack.push(...node.children);
      }
    }
    return null;
  }, [entries, routePath]);

  // Fetch governance_mode from admin config on mount
  useEffect(() => {
    apiClient.getAdminConfig().then((config) => {
      setGovernanceMode(config.governance_mode ?? "available");
    }).catch(() => { /* non-fatal */ });
  }, []);

  if (routePath === null) {
    return <DocsBrowserPage />;
  }

  if (resolved.docPath === null || resolvedEntryType === "directory") {
    return <FolderPage folderPath={routePath} />;
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

  const titleAccessory: ReactNode = (
    <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
  );

  if (viewMode === "governance") {
    return (
      <GovernanceDocumentPage
        key={resolved.docPath}
        docPathOverride={resolved.docPath}
        titleAccessory={titleAccessory}
      />
    );
  }

  if (viewMode === "agent") {
    return (
      <AgentDocumentPage
        key={resolved.docPath}
        docPathOverride={resolved.docPath}
        titleAccessory={titleAccessory}
      />
    );
  }

  return (
    <DocumentPage
      key={resolved.docPath}
      docPathOverride={resolved.docPath}
      titleAccessory={titleAccessory}
    />
  );
}
