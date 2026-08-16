import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";

interface HomeDocsCardProps {
  folderCount: number;
  documentCount: number;
  layoutMode?: DocLayoutMode;
}

function FolderGlyph() {
  return (
    <svg className="home-docs-card__icon" width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3.5 7.25A1.75 1.75 0 0 1 5.25 5.5h4.1l1.4 1.7h8A1.75 1.75 0 0 1 20.5 9v8.25A1.75 1.75 0 0 1 18.75 19H5.25A1.75 1.75 0 0 1 3.5 17.25V7.25Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HomeDocsCard({ folderCount, documentCount, layoutMode: _layoutMode = "narrow" }: HomeDocsCardProps) {
  const folders = `${folderCount} folder${folderCount === 1 ? "" : "s"}`;
  const documents = `${documentCount} document${documentCount === 1 ? "" : "s"}`;
  return (
    <Link to="/docs" className="home-card home-docs-card" aria-label={`Open docs. ${folders}, ${documents}.`}>
      <FolderGlyph />
      <span className="home-docs-card__body">
        <span className="home-docs-card__title">docs/</span>
        <span className="home-docs-card__meta">
          {folders} {"\u00b7"} {documents}
        </span>
      </span>
      <span className="home-docs-card__chevron" aria-hidden="true">
        {"\u203a"}
      </span>
    </Link>
  );
}
