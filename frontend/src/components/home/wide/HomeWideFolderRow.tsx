import { Link } from "react-router-dom";
import { folderHref } from "../../../app/docs-location";
import { FolderTreeRadialDots } from "../../folder-details/FolderTreeRadialDots";
import type { HomeActiveFolder } from "../../../pages/home/home-folder-activity";
import { formatHomeAge } from "../../../pages/home/home-utils";
import { FolderChangeBars } from "../HomeActiveFolderCard";

interface HomeWideFolderRowProps {
  folder: HomeActiveFolder;
  now?: Date;
}

export function HomeWideFolderRow({ folder, now }: HomeWideFolderRowProps) {
  const tree = folder.tree ?? {
    type: "directory" as const,
    name: folder.name,
    path: folder.folderPath,
    children: [],
  };
  return (
    <Link className="folder-row" to={folderHref(folder.folderPath)}>
      <span className="folder-row__main">
        <span className="folder-row__name font-body">
          <FolderTreeRadialDots entry={tree} className="folder-row__icon" />
          <span className="folder-row__name-text">{folder.name}</span>
        </span>
        {folder.changedDocuments.length > 0 ? (
          <span className="folder-row__meta">
            <svg
              className="folder-row__files-icon"
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4.5 2.25h5.1L12.5 5.15V13.25a.75.75 0 0 1-.75.75h-7.25a.75.75 0 0 1-.75-.75V3a.75.75 0 0 1 .75-.75Z"
                stroke="currentColor"
                strokeWidth="1.25"
                strokeLinejoin="round"
              />
              <path d="M9.25 2.35V5.5H12.3" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
            </svg>
            <span className="folder-row__files">{folder.changedDocuments.join(", ")}</span>
          </span>
        ) : null}
      </span>
      <FolderChangeBars counts={folder.counts} />
      <span className="folder-row__age">{formatHomeAge(new Date(folder.lastChangedAt), now)}</span>
    </Link>
  );
}
