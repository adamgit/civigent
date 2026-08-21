import { useMemo, type ReactNode } from "react";
import type { ActivityItem, HumanInvolvementPresetName, LoginProvider } from "../../types/shared.js";
import type { HomeActiveFolder } from "./home-folder-activity";
import type { HomeRecentDocument } from "./home-recent-documents";
import type { HomeFolderWindowId, HomeRecentWindowId } from "./home-constants";
import { HomeCarousel, type HomeCarouselSlide } from "../../components/home/HomeCarousel";
import { HomeFocusBrowseSlide } from "../../components/home/HomeFocusBrowseSlide";
import { HomeSearchBar } from "../../components/home/HomeSearchBar";
import { HomeSingleUserSlide } from "../../components/home/HomeSingleUserSlide";
import { HomeFolderIconsSlide } from "../../components/home/HomeFolderIconsSlide";
import { HomeSkillsSlide } from "../../components/home/HomeSkillsSlide";
import { BrowseRootButton } from "../../components/home/wide/BrowseRootButton";
import { HomeWideActiveFolders } from "../../components/home/wide/HomeWideActiveFolders";
import { HomeWideAgentPulse } from "../../components/home/wide/HomeWideAgentPulse";
import { HomeWideRecentDocuments } from "../../components/home/wide/HomeWideRecentDocuments";
import { SiteMasthead } from "../../components/home/wide/SiteMasthead";
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
  sidebarAutoHide: boolean;
  setSidebarAutoHide: (autoHide: boolean) => void;
  mcpActions: HomeMcpPulseAction[];
  pulseActivity: ActivityItem[];
  agentTasks: HomeAgentTask[];
  pulseError: string | null;
}

export function HomeWideLayout({
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
  recentDocumentTotal,
  recentWindowId,
  onRecentWindowChange,
  alerts,
  singleUser,
  authMode,
  sidebarAutoHide,
  setSidebarAutoHide,
  mcpActions,
  pulseActivity,
  agentTasks,
  pulseError,
}: HomeWideLayoutProps) {
  const slides = useMemo<HomeCarouselSlide[]>(() => {
    const items: HomeCarouselSlide[] = [
      {
        id: "layout",
        title: "Focus or Browse",
        content: (
          <HomeFocusBrowseSlide
            sidebarAutoHide={sidebarAutoHide}
            setSidebarAutoHide={setSidebarAutoHide}
          />
        ),
      },
    ];
    if (singleUser) {
      items.push({
        id: "single-user",
        title: "Single-user mode",
        content: <HomeSingleUserSlide hideHeading />,
      });
    }
    items.push({
      id: "folder-icons",
      title: "How folder icons work",
      content: <HomeFolderIconsSlide />,
    });
    items.push({
      id: "skills",
      title: "Turn a folder into agent skills",
      content: <HomeSkillsSlide />,
    });
    return items;
  }, [singleUser, sidebarAutoHide, setSidebarAutoHide]);

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
                <HomeCarousel slides={slides} />
              </div>
            </header>

            <div className="home-wide-flow">
              <HomeWideAgentPulse
                actions={mcpActions}
                activity={pulseActivity}
                tasks={agentTasks}
                pulseError={pulseError}
              />

              <div className="home-human-band">
                <HomeWideActiveFolders
                  folders={folders}
                  totalFolderCount={folderCount}
                  windowId={folderWindowId}
                  onWindowChange={onFolderWindowChange}
                />
                <HomeWideRecentDocuments
                  documents={recentDocuments}
                  totalCount={recentDocumentTotal}
                  windowId={recentWindowId}
                  onWindowChange={onRecentWindowChange}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
