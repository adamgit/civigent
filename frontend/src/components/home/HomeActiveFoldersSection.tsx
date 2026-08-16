import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import { FolderPath } from "../../types/shared.js";
import type { HomeActiveFolder } from "../../pages/home/home-folder-activity";
import { HomeActiveFolderCard } from "./HomeActiveFolderCard";

interface HomeActiveFoldersSectionProps {
  folders: HomeActiveFolder[];
  allDocsFolder?: HomeActiveFolder | null;
  layoutMode?: DocLayoutMode;
}

export function HomeActiveFoldersSection({
  folders,
  allDocsFolder = null,
  layoutMode = "narrow",
}: HomeActiveFoldersSectionProps) {
  const rest = allDocsFolder
    ? folders.filter((folder) => folder.folderPath !== FolderPath.root)
    : folders;
  if (!allDocsFolder && rest.length === 0) return null;
  return (
    <section className={`home-folders${layoutMode === "wide" ? " home-folders--wide" : ""}`} aria-label="Active folders">
      <div className="home-folders__head">
        <h2 className="home-section-label">Active folders</h2>
        <div className="home-folders__legend" aria-hidden="true">
          <span className="home-folders__legend-item">
            <span className="home-folders__dot home-folders__dot--add" />
            add
          </span>
          <span className="home-folders__legend-item">
            <span className="home-folders__dot home-folders__dot--mod" />
            mod
          </span>
          <span className="home-folders__legend-item">
            <span className="home-folders__dot home-folders__dot--del" />
            del
          </span>
        </div>
      </div>
      <div className="home-folders__scroller">
        {allDocsFolder ? (
          <HomeActiveFolderCard folder={allDocsFolder} layoutMode={layoutMode} variant="all-docs" />
        ) : null}
        {rest.map((folder) => (
          <HomeActiveFolderCard key={folder.folderPath} folder={folder} layoutMode={layoutMode} />
        ))}
      </div>
    </section>
  );
}
