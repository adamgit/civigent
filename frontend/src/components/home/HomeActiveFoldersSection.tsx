import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import type { HomeActiveFolder } from "../../pages/home/home-folder-activity";
import { HomeActiveFolderCard } from "./HomeActiveFolderCard";

interface HomeActiveFoldersSectionProps {
  folders: HomeActiveFolder[];
  layoutMode?: DocLayoutMode;
}

export function HomeActiveFoldersSection({
  folders,
  layoutMode = "narrow",
}: HomeActiveFoldersSectionProps) {
  if (folders.length === 0) return null;
  return (
    <section className="home-folders" aria-label="Active folders">
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
        {folders.map((folder) => (
          <HomeActiveFolderCard key={folder.folderPath} folder={folder} layoutMode={layoutMode} />
        ))}
      </div>
    </section>
  );
}
