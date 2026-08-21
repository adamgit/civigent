import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import { folderHref } from "../../app/docs-location";
import type { HomeActiveFolder } from "../../pages/home/home-folder-activity";

interface HomeActiveFolderCardProps {
  folder: HomeActiveFolder;
  layoutMode?: DocLayoutMode;
  variant?: "default" | "all-docs";
}

const BAR_MAX_PX = 16;

function barHeight(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(3, Math.round((value / max) * BAR_MAX_PX));
}

export function FolderChangeBars({
  counts,
}: {
  counts: HomeActiveFolder["counts"];
}) {
  const max = Math.max(counts.added, counts.modified, counts.deleted);
  return (
    <span className="home-folder-card__bars" aria-hidden="true">
      <Bar kind="add" value={counts.added} max={max} />
      <Bar kind="mod" value={counts.modified} max={max} />
      <Bar kind="del" value={counts.deleted} max={max} />
    </span>
  );
}

export function HomeActiveFolderCard({
  folder,
  layoutMode: _layoutMode = "narrow",
  variant = "default",
}: HomeActiveFolderCardProps) {
  const docs = `${folder.docCount} doc${folder.docCount === 1 ? "" : "s"}`;
  const allDocs = variant === "all-docs";
  return (
    <Link
      to={folderHref(folder.folderPath)}
      className={
        allDocs
          ? "home-card home-folder-card home-folder-card--all bg-accent-light border-accent-border"
          : "home-card home-folder-card"
      }
    >
      <span className={`home-folder-card__name${allDocs ? " text-accent-text" : ""}`}>
        {folder.name}
      </span>
      <span className={`home-folder-card__count${allDocs ? " text-accent-text" : ""}`}>
        {allDocs ? `all docs · ${folder.docCount}` : docs}
      </span>
      <FolderChangeBars counts={folder.counts} />
    </Link>
  );
}

function Bar({ kind, value, max }: { kind: "add" | "mod" | "del"; value: number; max: number }) {
  const height = barHeight(value, max);
  if (height === 0) {
    return <span className={`home-folder-card__bar home-folder-card__bar--empty`} />;
  }
  return (
    <span
      className={`home-folder-card__bar home-folder-card__bar--${kind}`}
      style={{ height }}
      title={`${kind} ${value}`}
    />
  );
}
