import type { ReactNode } from "react";
import type { AgentRead, HumanInvolvementPresetName, LoginProvider } from "../../types/shared.js";
import type { AgentPulseData } from "../../hooks/useAgentActivityFeeds";
import type { Feed } from "../../utils/feed-state";
import { FeedView } from "../../components/feed/FeedView";
import type { HomeActiveFolder } from "./home-folder-activity";
import type { HomeRecentDocumentsData } from "./home-recent-documents";
import type { HomeFolderWindowId, HomeRecentWindowId } from "./home-constants";
import { HomeMemoryWidget } from "../../components/home/HomeMemoryWidget";
import { HomeSearchBar } from "../../components/home/HomeSearchBar";
import { BrowseRootButton } from "../../components/home/wide/BrowseRootButton";
import { HomeWideActiveFolders } from "../../components/home/wide/HomeWideActiveFolders";
import { HomeWideAgentPulse } from "../../components/home/wide/HomeWideAgentPulse";
import { HomeWideRecentDocuments } from "../../components/home/wide/HomeWideRecentDocuments";
import { SiteMasthead } from "../../components/home/wide/SiteMasthead";
import "./home.css";

interface HomeWideLayoutClassicProps {
  hostLabel: string;
  tagline: string;
  involvementPreset: HumanInvolvementPresetName | null;
  documentCount: number;
  folderCount: number;
  agentCount: number;
  lastChangeAt: string | null;
  folders: Feed<HomeActiveFolder[]>;
  folderWindowId: HomeFolderWindowId;
  onFolderWindowChange: (id: HomeFolderWindowId) => void;
  recentDocuments: Feed<HomeRecentDocumentsData>;
  recentWindowId: HomeRecentWindowId;
  onRecentWindowChange: (id: HomeRecentWindowId) => void;
  alerts: ReactNode;
  singleUser: boolean;
  authMode: LoginProvider | null;
  agentPulse: Feed<AgentPulseData>;
  agentReads: AgentRead[];
}

export function HomeWideLayoutClassic({
  hostLabel,
  tagline,
  involvementPreset,
  documentCount,
  folderCount,
  agentCount,
  lastChangeAt,
  folders,
  folderWindowId,
  onFolderWindowChange,
  recentDocuments,
  recentWindowId,
  onRecentWindowChange,
  alerts,
  singleUser,
  authMode,
  agentPulse,
  agentReads,
}: HomeWideLayoutClassicProps) {
  return (
    <div className="home-wide" data-home-layout="wide">
      <div className="home-wide__body sidebar-scroll">
        <div className="home-page">
          {alerts}
          <div className="home-frame">
            <header className="home-welcome">
              <SiteMasthead
                hostLabel={hostLabel}
                tagline={tagline}
                documentCount={documentCount}
                folderCount={folderCount}
                agentCount={agentCount}
                lastChangeAt={lastChangeAt}
                involvementPreset={involvementPreset}
                authMode={authMode}
              />
              <div className="home-welcome__actions">
                <div className="home-welcome__pair">
                  <HomeSearchBar />
                  <BrowseRootButton documentCount={documentCount} folderCount={folderCount} />
                </div>
                <HomeMemoryWidget />
              </div>
            </header>

            <div className="home-wide-flow">
              <HomeWideAgentPulse pulse={agentPulse} reads={agentReads} />

              <div className="home-human-band">
                <HomeWideActiveFolders
                  folders={folders}
                  totalFolderCount={folderCount}
                  windowId={folderWindowId}
                  onWindowChange={onFolderWindowChange}
                />
                <FeedView feed={recentDocuments} subject="recent documents">
                  {({ documents, totalCount }) => (
                    <HomeWideRecentDocuments
                      documents={documents}
                      totalCount={totalCount}
                      windowId={recentWindowId}
                      onWindowChange={onRecentWindowChange}
                    />
                  )}
                </FeedView>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
