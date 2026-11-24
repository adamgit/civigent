import type { ReactNode } from "react";
import type { AgentRead, HumanInvolvementPresetName, LoginProvider } from "../../types/shared.js";
import type { AgentPulseData } from "../../hooks/useAgentActivityFeeds";
import type { Feed } from "../../utils/feed-state";
import type { HomeActiveFolder } from "./home-folder-activity";
import type { HomeRecentDocumentsData } from "./home-recent-documents";
import type { HomeFolderWindowId, HomeRecentWindowId } from "./home-constants";
import { HomeWideActiveFolders } from "../../components/home/wide/HomeWideActiveFolders";
import { HomeWideAgentPulse } from "../../components/home/wide/HomeWideAgentPulse";
import { HomeWideMasthead } from "../../components/home/wide/HomeWideMasthead";
import { HomeWideRecentDocumentsCompact } from "../../components/home/wide/HomeWideRecentDocumentsCompact";
import "./home.css";

interface HomeWideLayoutProps {
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

export function HomeWideLayout({
  hostLabel,
  involvementPreset,
  documentCount,
  folderCount,
  agentCount,
  folders,
  folderWindowId,
  onFolderWindowChange,
  recentDocuments,
  recentWindowId,
  onRecentWindowChange,
  alerts,
  authMode,
  agentPulse,
  agentReads,
}: HomeWideLayoutProps) {
  return (
    <div className="home-wide" data-home-layout="wide" data-home-wide="redesign">
      <div className="home-wide__body sidebar-scroll">
        <div className="home-page">
          {alerts}
          <div className="home-frame">
            <HomeWideMasthead
              hostLabel={hostLabel}
              documentCount={documentCount}
              folderCount={folderCount}
              agentCount={agentCount}
              involvementPreset={involvementPreset}
              authMode={authMode}
            />

            <div className="home-wide-main">
              <div className="home-wide-columns">
                <HomeWideAgentPulse pulse={agentPulse} reads={agentReads} />

                <div className="home-wide-rail">
                  <HomeWideRecentDocumentsCompact
                    recent={recentDocuments}
                    windowId={recentWindowId}
                    onWindowChange={onRecentWindowChange}
                  />
                  <HomeWideActiveFolders
                    folders={folders}
                    totalFolderCount={folderCount}
                    windowId={folderWindowId}
                    onWindowChange={onFolderWindowChange}
                    showParentPath
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
