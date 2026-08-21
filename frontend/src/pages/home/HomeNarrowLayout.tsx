import type { ReactNode } from "react";
import type { HumanInvolvementPresetName, LoginProvider } from "../../types/shared.js";
import type { HomeActiveFolder } from "./home-folder-activity";
import type { HomeAgentActivityRowModel } from "./home-agent-activity";
import type { HomeRecentDocument } from "./home-recent-documents";
import { HomeHeader } from "../../components/home/HomeHeader";
import { HomeInvolvementWaitLine } from "../../components/home/HomeInvolvementWaitLine";
import { HomeSingleUserSlide } from "../../components/home/HomeSingleUserSlide";
import { HomeDocsSearchRow } from "../../components/home/HomeDocsSearchRow";
import { HomeActiveFoldersSection } from "../../components/home/HomeActiveFoldersSection";
import { HomeAgentActivitySection } from "../../components/home/HomeAgentActivitySection";
import { HomeRecentDocumentsSection } from "../../components/home/HomeRecentDocumentsSection";
import { HOME_RECENT_WINDOW_DEFAULT } from "./home-constants";
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
  singleUser: boolean;
  authMode: LoginProvider | null;
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
  singleUser,
  authMode,
}: HomeNarrowLayoutProps) {
  return (
    <div className="home-narrow" data-home-layout="narrow">
      <div className="home-narrow__chrome">
        <div className="home-narrow__chrome-inner">
          <HomeHeader title={title} hostLabel={hostLabel} authMode={authMode} />
          {involvementPreset ? (
            <HomeInvolvementWaitLine preset={involvementPreset} layoutMode="narrow" />
          ) : null}
        </div>
      </div>
      <div className="home-narrow__body sidebar-scroll">
        <div className="home-narrow__body-inner">
          {alerts}
          {singleUser ? (
            <div className="home-card home-narrow__single-user">
              <HomeSingleUserSlide />
            </div>
          ) : null}
          <HomeDocsSearchRow folderCount={folderCount} documentCount={documentCount} layoutMode="narrow" />
          <HomeActiveFoldersSection folders={folders} layoutMode="narrow" />
          <HomeAgentActivitySection rows={agentRows} layoutMode="narrow" />
          <HomeRecentDocumentsSection
            documents={recentDocuments}
            totalCount={recentDocumentTotal}
            layoutMode="narrow"
            windowId={HOME_RECENT_WINDOW_DEFAULT}
          />
        </div>
      </div>
    </div>
  );
}
