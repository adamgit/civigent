import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  HOME_FOLDER_WINDOW_OPTIONS,
  HOME_WIDE_LIST_PAGE_SIZE,
  type HomeFolderWindowId,
} from "../../../pages/home/home-constants";
import type { HomeActiveFolder } from "../../../pages/home/home-folder-activity";
import { formatHomeCount } from "../../../pages/home/home-utils";
import { HomeWideFolderRow } from "./HomeWideFolderRow";
import { HomeWidePager } from "./HomeWidePager";
import { PanelHeader } from "./PanelHeader";
import { SegmentedControl } from "./SegmentedControl";

interface HomeWideActiveFoldersProps {
  folders: HomeActiveFolder[];
  totalFolderCount: number;
  windowId: HomeFolderWindowId;
  onWindowChange: (id: HomeFolderWindowId) => void;
  now?: Date;
}

export function HomeWideActiveFolders({
  folders,
  totalFolderCount,
  windowId,
  onWindowChange,
  now,
}: HomeWideActiveFoldersProps) {
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [windowId]);

  const pageCount = Math.max(1, Math.ceil(folders.length / HOME_WIDE_LIST_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const slice = folders.slice(
    safePage * HOME_WIDE_LIST_PAGE_SIZE,
    safePage * HOME_WIDE_LIST_PAGE_SIZE + HOME_WIDE_LIST_PAGE_SIZE,
  );

  return (
    <section className="home-panel" aria-labelledby="active-folders-heading">
      <PanelHeader
        id="active-folders-heading"
        title="Active folders"
        subtitle={
          <span className="folder-legend">
            <i className="folder-legend__swatch folder-legend__swatch--add" /> add
            <i className="folder-legend__swatch folder-legend__swatch--mod" /> mod
            <i className="folder-legend__swatch folder-legend__swatch--del" /> del
          </span>
        }
      >
        <SegmentedControl
          label="Folder activity timeframe"
          options={HOME_FOLDER_WINDOW_OPTIONS.map((option) => ({
            value: option.id,
            label: option.label,
          }))}
          value={windowId}
          onChange={(value) => onWindowChange(value as HomeFolderWindowId)}
        />
        <Link className="panel-header__link" to="/docs">
          All {formatHomeCount(totalFolderCount)} →
        </Link>
      </PanelHeader>

      <div>
        {folders.length === 0 ? (
          <p className="home-recent__empty" style={{ padding: "14px 20px" }}>
            No folder activity in this window.
          </p>
        ) : (
          slice.map((folder) => <HomeWideFolderRow key={folder.folderPath} folder={folder} now={now} />)
        )}
        <HomeWidePager
          page={safePage}
          pageSize={HOME_WIDE_LIST_PAGE_SIZE}
          total={folders.length}
          setPage={setPage}
          label="Active folders pages"
        />
      </div>
    </section>
  );
}
