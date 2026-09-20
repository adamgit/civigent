import type { MouseEvent, Ref } from "react";
import { Link } from "react-router-dom";
import { folderHref } from "../../../app/docs-location";
import { FolderTreeRadialDots } from "../../folder-details/FolderTreeRadialDots";
import type { HomeActiveFolder } from "../../../pages/home/home-folder-activity";
import { formatHomeAge, formatHomeFolderParentPath } from "../../../pages/home/home-utils";
import { FolderChangeBars } from "../HomeActiveFolderCard";

interface HomeWideFolderRowProps {
  folder: HomeActiveFolder;
  now?: Date;
  showParentPath?: boolean;
  open?: boolean;
  rowRef: Ref<HTMLAnchorElement>;
  onTogglePane: () => void;
}

export function HomeWideFolderRow({
  folder,
  now,
  showParentPath = false,
  open = false,
  rowRef,
  onTogglePane,
}: HomeWideFolderRowProps) {
  const tree = folder.tree ?? {
    type: "directory" as const,
    name: folder.name,
    path: folder.folderPath,
    children: [],
  };
  const parentPath = showParentPath ? formatHomeFolderParentPath(folder.folderPath) : null;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-folder-pane-toggle]")) {
      event.preventDefault();
      onTogglePane();
    }
  };

  return (
    <Link
      ref={rowRef}
      className={`folder-row${folder.writerKind === "agent" ? " folder-row--agent" : ""}${open ? " folder-row--open" : ""}`}
      to={folderHref(folder.folderPath)}
      data-writer-kind={folder.writerKind}
      onClick={handleClick}
    >
      <span className="folder-row__main">
        <span className="folder-row__name font-body">
          <FolderTreeRadialDots entry={tree} className="folder-row__icon" />
          <span className="folder-row__name-text">{folder.name}</span>
          {parentPath ? <span className="folder-row__path">{parentPath}</span> : null}
        </span>
        {folder.changedDocuments.length > 0 ? (
          <span className="folder-row__meta" data-folder-pane-toggle>
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
            <span className="folder-row__files">
              {folder.changedDocuments.map((doc) => doc.title).join(", ")}
            </span>
          </span>
        ) : null}
      </span>
      <span className="folder-row__peek" data-folder-pane-toggle>
        <FolderChangeBars counts={folder.counts} />
        <span className="folder-row__age">{formatHomeAge(new Date(folder.lastChangedAt), now)}</span>
        <span className="folder-row__peek-mark" aria-hidden="true">
          i
        </span>
      </span>
    </Link>
  );
}
