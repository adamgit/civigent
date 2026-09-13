import type { ReactNode } from "react";
import type { ActivityItem, HumanInvolvementPresetName, LoginProvider } from "../../types/shared.js";
import type { HomeActiveFolder } from "./home-folder-activity";
import type { HomeRecentDocument } from "./home-recent-documents";
import type { HomeFolderWindowId, HomeRecentWindowId } from "./home-constants";
import { HomeWideActiveFolders } from "../../components/home/wide/HomeWideActiveFolders";
import { HomeWideAgentPulse } from "../../components/home/wide/HomeWideAgentPulse";
import { HomeWideMasthead } from "../../components/home/wide/HomeWideMasthead";
import { HomeWidePreamble } from "../../components/home/wide/HomeWidePreamble";
import { HomeWideRecentDocumentsCompact } from "../../components/home/wide/HomeWideRecentDocumentsCompact";
import type { HomeAgentTask, HomeMcpPulseAction } from "../../components/home/experiment/types";
import "./home.css";

interface HomeWideLayoutProps {
  hostLabel: string;
  tagline: string;
  involvementPreset: HumanInvolvementPresetName | null;
  documentCount: number;
  folderCount: number;
  agentCount: number;
  lastChangeAt: string | null;
  folders: HomeActiveFolder[];
  folderWindowId: HomeFolderWindowId;
  onFolderWindowChange: (id: HomeFolderWindowId) => void;
  recentDocuments: HomeRecentDocument[];
  recentDocumentTotal: number;
  recentWindowId: HomeRecentWindowId;
  onRecentWindowChange: (id: HomeRecentWindowId) => void;
  alerts: ReactNode;
  singleUser: boolean;
  authMode: LoginProvider | null;
  mcpActions: HomeMcpPulseAction[];
  pulseActivity: ActivityItem[];
  agentTasks: HomeAgentTask[];
  pulseError: string | null;
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
  recentDocumentTotal,
  recentWindowId,
  onRecentWindowChange,
  alerts,
  authMode,
  mcpActions,
  pulseActivity,
  agentTasks,
  pulseError,
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
              {/* <HomeWidePreamble /> */}
              <div className="home-wide-columns">
                <HomeWideAgentPulse
                  actions={mcpActions}
                  activity={pulseActivity}
                  tasks={agentTasks}
                  pulseError={pulseError}
                />

                <div className="home-wide-rail">
                  <HomeWideRecentDocumentsCompact
                    documents={recentDocuments}
                    totalCount={recentDocumentTotal}
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
