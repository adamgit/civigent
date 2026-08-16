import type { ReactNode } from "react";
import type { HumanInvolvementPresetName } from "../../types/shared.js";
import type { HomeActiveFolder } from "./home-folder-activity";
import type { HomeAgentActivityRowModel } from "./home-agent-activity";
import type { HomeRecentDocument } from "./home-recent-documents";
import { HomeHeader } from "../../components/home/HomeHeader";
import { HomeInvolvementWaitLine } from "../../components/home/HomeInvolvementWaitLine";
import { HomeDocsSearchRow } from "../../components/home/HomeDocsSearchRow";
import { HomeActiveFoldersSection } from "../../components/home/HomeActiveFoldersSection";
import { HomeAgentActivitySection } from "../../components/home/HomeAgentActivitySection";
import { HomeRecentDocumentsSection } from "../../components/home/HomeRecentDocumentsSection";
import "./home.css";

interface HomeNarrowLayoutProps {
  title: string;
  hostLabel: string;
  involvementPreset: HumanInvolvementPresetName | null;
  folderCount: number;
  documentCount: number;
  folders: HomeActiveFolder[];
  agentRows: HomeAgentActivityRowModel[];
  recentDocuments: HomeRecentDocument[];
  recentDocumentTotal: number;
  alerts: ReactNode;
  showCreateForm: boolean;
  createForm: ReactNode;
  onCreateDocument: () => void;
}

export function HomeNarrowLayout({
  title,
  hostLabel,
  involvementPreset,
  folderCount,
  documentCount,
  folders,
  agentRows,
  recentDocuments,
  recentDocumentTotal,
  alerts,
  showCreateForm,
  createForm,
  onCreateDocument,
}: HomeNarrowLayoutProps) {
  return (
    <div className="home-narrow canvas-scroll" data-home-layout="narrow">
      <div className="home-narrow__inner">
        {alerts}
        <HomeHeader title={title} hostLabel={hostLabel} onCreateDocument={onCreateDocument} />
        {involvementPreset ? (
          <HomeInvolvementWaitLine preset={involvementPreset} layoutMode="narrow" />
        ) : null}
        {showCreateForm ? createForm : null}
        <HomeDocsSearchRow folderCount={folderCount} documentCount={documentCount} layoutMode="narrow" />
        <HomeActiveFoldersSection folders={folders} layoutMode="narrow" />
        <HomeAgentActivitySection rows={agentRows} layoutMode="narrow" />
        <HomeRecentDocumentsSection
          documents={recentDocuments}
          totalCount={recentDocumentTotal}
          layoutMode="narrow"
        />
      </div>
    </div>
  );
}
