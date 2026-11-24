import type { ReactNode } from "react";
import type { HumanInvolvementPresetName, LoginProvider } from "../../types/shared.js";
import type { HomeActiveFolder } from "./home-folder-activity";
import type { HomeAgentRowsData } from "./home-agent-activity";
import type { HomeRecentDocumentsData } from "./home-recent-documents";
import type { Feed } from "../../utils/feed-state";
import { FeedView } from "../../components/feed/FeedView";
import { HomeHeader } from "../../components/home/HomeHeader";
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
  folders: Feed<HomeActiveFolder[]>;
  agentRows: Feed<HomeAgentRowsData>;
  recentDocuments: Feed<HomeRecentDocumentsData>;
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
  alerts,
  singleUser,
  authMode,
}: HomeNarrowLayoutProps) {
  return (
    <div className="home-narrow" data-home-layout="narrow">
      <div className="home-narrow__chrome">
        <div className="home-narrow__chrome-inner">
          <HomeHeader
            title={title}
            hostLabel={hostLabel}
            authMode={authMode}
            involvementPreset={involvementPreset}
          />
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
          <FeedView feed={folders} subject="folder activity">
            {(loadedFolders) => <HomeActiveFoldersSection folders={loadedFolders} layoutMode="narrow" />}
          </FeedView>
          <HomeAgentActivitySection rows={agentRows} layoutMode="narrow" />
          <FeedView feed={recentDocuments} subject="recent documents">
            {({ documents, totalCount }) => (
              <HomeRecentDocumentsSection
                documents={documents}
                totalCount={totalCount}
                layoutMode="narrow"
                windowId={HOME_RECENT_WINDOW_DEFAULT}
              />
            )}
          </FeedView>
        </div>
      </div>
    </div>
  );
}
