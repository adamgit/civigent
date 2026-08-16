import { useMemo, type ReactNode } from "react";
import type { HumanInvolvementPresetName } from "../../types/shared.js";
import type { HomeActiveFolder } from "./home-folder-activity";
import type { HomeAgentActivityRowModel } from "./home-agent-activity";
import type { HomeRecentDocument } from "./home-recent-documents";
import type { HomeRecentWindowId } from "./home-constants";
import { HomeHeader } from "../../components/home/HomeHeader";
import { HomeInvolvementWaitLine } from "../../components/home/HomeInvolvementWaitLine";
import { HomeCarousel, type HomeCarouselSlide } from "../../components/home/HomeCarousel";
import { HomeSkillsSlide } from "../../components/home/HomeSkillsSlide";
import { HomeFocusBrowseSlide } from "../../components/home/HomeFocusBrowseSlide";
import { HomeSingleUserSlide } from "../../components/home/HomeSingleUserSlide";
import { HomeSearchBar } from "../../components/home/HomeSearchBar";
import { HomeActiveFoldersSection } from "../../components/home/HomeActiveFoldersSection";
import { HomeAgentActivitySection } from "../../components/home/HomeAgentActivitySection";
import { HomeRecentDocumentsSection } from "../../components/home/HomeRecentDocumentsSection";
import "./home.css";

interface HomeWideLayoutProps {
  title: string;
  hostLabel: string;
  involvementPreset: HumanInvolvementPresetName | null;
  folders: HomeActiveFolder[];
  allDocsFolder: HomeActiveFolder;
  agentRows: HomeAgentActivityRowModel[];
  recentDocuments: HomeRecentDocument[];
  recentDocumentTotal: number;
  recentWindowId: HomeRecentWindowId;
  onRecentWindowChange: (id: HomeRecentWindowId) => void;
  alerts: ReactNode;
  singleUser: boolean;
  sidebarAutoHide: boolean;
  setSidebarAutoHide: (autoHide: boolean) => void;
}

export function HomeWideLayout({
  title,
  hostLabel,
  involvementPreset,
  folders,
  allDocsFolder,
  agentRows,
  recentDocuments,
  recentDocumentTotal,
  recentWindowId,
  onRecentWindowChange,
  alerts,
  singleUser,
  sidebarAutoHide,
  setSidebarAutoHide,
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
        content: <HomeSingleUserSlide />,
      });
    }
    items.push({
      id: "skills",
      title: "Turn a folder into agent skills",
      content: <HomeSkillsSlide />,
    });
    return items;
  }, [singleUser, sidebarAutoHide, setSidebarAutoHide]);

  return (
    <div className="home-wide" data-home-layout="wide">
      <div className="home-wide__chrome">
        <HomeHeader
          title={title}
          hostLabel={hostLabel}
          trailing={
            involvementPreset ? (
              <HomeInvolvementWaitLine preset={involvementPreset} layoutMode="wide" />
            ) : null
          }
        />
      </div>
      <div className="home-wide__body sidebar-scroll">
        {alerts}
        <HomeCarousel slides={slides} />
        <HomeSearchBar />
        <HomeActiveFoldersSection folders={folders} allDocsFolder={allDocsFolder} layoutMode="wide" />
        <div className="home-wide__bottom">
          <HomeRecentDocumentsSection
            documents={recentDocuments}
            totalCount={recentDocumentTotal}
            layoutMode="wide"
            windowId={recentWindowId}
            onWindowChange={onRecentWindowChange}
          />
          <HomeAgentActivitySection rows={agentRows} layoutMode="wide" />
        </div>
      </div>
    </div>
  );
}
