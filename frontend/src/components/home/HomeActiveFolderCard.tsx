import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import { folderHref } from "../../app/docs-location";
import type { HomeActiveFolder } from "../../pages/home/home-folder-activity";

interface HomeActiveFolderCardProps {
  folder: HomeActiveFolder;
  layoutMode?: DocLayoutMode;
}

const BAR_MAX_PX = 16;

function barHeight(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(3, Math.round((value / max) * BAR_MAX_PX));
}

export function HomeActiveFolderCard({ folder, layoutMode: _layoutMode = "narrow" }: HomeActiveFolderCardProps) {
  const max = Math.max(folder.counts.added, folder.counts.modified, folder.counts.deleted);
  const docs = `${folder.docCount} doc${folder.docCount === 1 ? "" : "s"}`;
  return (
    <Link to={folderHref(folder.folderPath)} className="home-card home-folder-card">
      <span className="home-folder-card__name">{folder.name}</span>
      <span className="home-folder-card__count">{docs}</span>
      <span className="home-folder-card__bars" aria-hidden="true">
        <Bar kind="add" value={folder.counts.added} max={max} />
        <Bar kind="mod" value={folder.counts.modified} max={max} />
        <Bar kind="del" value={folder.counts.deleted} max={max} />
      </span>
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
