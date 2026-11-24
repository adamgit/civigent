import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  HOME_FOLDER_WINDOW_OPTIONS,
  HOME_WIDE_FOLDER_PAGE_SIZE,
  type HomeFolderWindowId,
} from "../../../pages/home/home-constants";
import type { HomeActiveFolder } from "../../../pages/home/home-folder-activity";
import { formatHomeCount } from "../../../pages/home/home-utils";
import { loadedFeedDataOr, type Feed } from "../../../utils/feed-state";
import { FeedView } from "../../feed/FeedView";
import { HomeWideFolderHoverPane } from "./HomeWideFolderHoverPane";
import { HomeWideFolderRow } from "./HomeWideFolderRow";
import { HomeWidePager } from "./HomeWidePager";
import { PanelHeader } from "./PanelHeader";
import { SegmentedControl } from "./SegmentedControl";

const NO_FOLDERS: HomeActiveFolder[] = [];

interface HomeWideActiveFoldersProps {
  folders: Feed<HomeActiveFolder[]>;
  totalFolderCount: number;
  windowId: HomeFolderWindowId;
  onWindowChange: (id: HomeFolderWindowId) => void;
  now?: Date;
  showParentPath?: boolean;
}

function folderRowKey(folder: HomeActiveFolder): string {
  return `${folder.folderPath}\0${folder.writerKind}`;
}

export function HomeWideActiveFolders({
  folders: foldersFeed,
  totalFolderCount,
  windowId,
  onWindowChange,
  now,
  showParentPath = false,
}: HomeWideActiveFoldersProps) {
  const [page, setPage] = useState(0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLAnchorElement>());

  useEffect(() => {
    setPage(0);
  }, [windowId]);

  useEffect(() => {
    setOpenKey(null);
  }, [page, windowId]);

  const folders = loadedFeedDataOr(foldersFeed, NO_FOLDERS);
  const pageCount = Math.max(1, Math.ceil(folders.length / HOME_WIDE_FOLDER_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const slice = folders.slice(
    safePage * HOME_WIDE_FOLDER_PAGE_SIZE,
    safePage * HOME_WIDE_FOLDER_PAGE_SIZE + HOME_WIDE_FOLDER_PAGE_SIZE,
  );

  const openFolder = openKey ? slice.find((folder) => folderRowKey(folder) === openKey) : undefined;
  const openAnchor = openKey ? rowEls.current.get(openKey) : undefined;

  return (
    <section className="home-panel" data-home-active-folders aria-labelledby="active-folders-heading">
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

      <FeedView feed={foldersFeed} subject="folder activity">
        {() => (
          <>
            {folders.length === 0 ? (
              <p className="home-recent__empty" style={{ padding: "14px 20px" }}>
                No folder activity in this window.
              </p>
            ) : (
              slice.map((folder) => {
                const key = folderRowKey(folder);
                return (
                  <HomeWideFolderRow
                    key={key}
                    folder={folder}
                    now={now}
                    showParentPath={showParentPath}
                    open={openKey === key}
                    rowRef={(el) => {
                      if (el) rowEls.current.set(key, el);
                      else rowEls.current.delete(key);
                    }}
                    onTogglePane={() => setOpenKey((current) => (current === key ? null : key))}
                  />
                );
              })
            )}
            <HomeWidePager
              page={safePage}
              pageSize={HOME_WIDE_FOLDER_PAGE_SIZE}
              total={folders.length}
              setPage={setPage}
              label="Active folders pages"
            />
          </>
        )}
      </FeedView>
      {openFolder && openAnchor ? (
        <HomeWideFolderHoverPane folder={openFolder} anchor={openAnchor} />
      ) : null}
    </section>
  );
}
