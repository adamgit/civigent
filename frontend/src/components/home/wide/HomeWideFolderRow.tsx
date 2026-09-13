import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { folderHref } from "../../../app/docs-location";
import { FolderTreeRadialDots } from "../../folder-details/FolderTreeRadialDots";
import type { HomeActiveFolder } from "../../../pages/home/home-folder-activity";
import { formatHomeAge, formatHomeFolderParentPath } from "../../../pages/home/home-utils";
import { FolderChangeBars } from "../HomeActiveFolderCard";
import { HomeWideFolderHoverPane } from "./HomeWideFolderHoverPane";

interface HomeWideFolderRowProps {
  folder: HomeActiveFolder;
  now?: Date;
  showParentPath?: boolean;
}

export function HomeWideFolderRow({ folder, now, showParentPath = false }: HomeWideFolderRowProps) {
  const rowRef = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const tree = folder.tree ?? {
    type: "directory" as const,
    name: folder.name,
    path: folder.folderPath,
    children: [],
  };
  const parentPath = showParentPath ? formatHomeFolderParentPath(folder.folderPath) : null;

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  const show = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };
  const hide = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  return (
    <>
      <Link
        ref={rowRef}
        className={`folder-row${folder.writerKind === "agent" ? " folder-row--agent" : ""}`}
        to={folderHref(folder.folderPath)}
        data-writer-kind={folder.writerKind}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <span className="folder-row__main">
          <span className="folder-row__name font-body">
            <FolderTreeRadialDots entry={tree} className="folder-row__icon" />
            <span className="folder-row__name-text">{folder.name}</span>
            {parentPath ? <span className="folder-row__path">{parentPath}</span> : null}
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
              <span className="folder-row__files">
                {folder.changedDocuments.map((doc) => doc.title).join(", ")}
              </span>
            </span>
          ) : null}
        </span>
        <FolderChangeBars counts={folder.counts} />
        <span className="folder-row__age">{formatHomeAge(new Date(folder.lastChangedAt), now)}</span>
      </Link>
      {open && rowRef.current ? (
        <HomeWideFolderHoverPane folder={folder} anchor={rowRef.current} onEnter={show} onLeave={hide} />
      ) : null}
    </>
  );
}
