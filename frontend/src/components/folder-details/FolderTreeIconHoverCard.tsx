import type { DocumentTreeEntry } from "../../types/shared.js";
import { folderTreeIconLegend, readFolderTreeIcon } from "./folder-tree-icon-reading";
import { FolderTreeRadialDots } from "./FolderTreeRadialDots";

function LegendFolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.25A1.25 1.25 0 0 1 3.75 3h3.1l1.2 1.35h4.2A1.25 1.25 0 0 1 13.5 5.6v6.15A1.25 1.25 0 0 1 12.25 13H3.75A1.25 1.25 0 0 1 2.5 11.75V4.25Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FolderTreeIconHoverCard({ entry }: { entry: DocumentTreeEntry }) {
  const legend = folderTreeIconLegend(readFolderTreeIcon(entry));
  return (
    <span className="folder-card-icon-legend" aria-hidden="true">
      <span className="folder-card-icon-legend__icon">
        <FolderTreeRadialDots
          entry={entry}
          className="h-full w-full text-folder-link"
          nativeTitles={false}
          colorizeBranches
        />
      </span>
      <span className="folder-card-icon-legend__copy">
        <span className="folder-card-icon-legend__summary">
          <p>{legend.summary}</p>
        </span>
        {legend.folders.length > 0 ? (
          <>
            <hr className="folder-card-icon-legend__rule" />
            <ul className="folder-card-icon-legend__folders">
              {legend.folders.map((folder) => (
                <li key={folder.path} style={{ color: folder.hue }}>
                  <LegendFolderIcon />
                  <span>
                    <strong>{folder.name}</strong>
                    <span className="folder-card-icon-legend__detail"> — {folder.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {legend.leftoverNote ? (
          <p className="folder-card-icon-legend__leftover">{legend.leftoverNote}</p>
        ) : null}
      </span>
    </span>
  );
}
