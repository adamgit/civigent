import { Link } from "react-router-dom";
import { formatHomeCount } from "../../../pages/home/home-utils";

interface BrowseRootButtonProps {
  documentCount: number;
  folderCount: number;
}

function FolderGlyph() {
  return (
    <svg className="home-browse-root__icon" width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3.5 7.25A1.75 1.75 0 0 1 5.25 5.5h4.1l1.4 1.7h8A1.75 1.75 0 0 1 20.5 9v8.25A1.75 1.75 0 0 1 18.75 19H5.25A1.75 1.75 0 0 1 3.5 17.25V7.25Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrowseRootButton({ documentCount, folderCount }: BrowseRootButtonProps) {
  const folders = `${formatHomeCount(folderCount)} folder${folderCount === 1 ? "" : "s"}`;
  const documents = `${formatHomeCount(documentCount)} document${documentCount === 1 ? "" : "s"}`;
  return (
    <Link to="/docs" className="home-card home-browse-root" aria-label={`Browse everything. ${documents}, ${folders}.`}>
      <FolderGlyph />
      <span className="home-browse-root__text">
        <strong>Browse everything</strong>
        <span>
          {documents} {"\u00b7"} {folders}
        </span>
      </span>
      <span className="home-browse-root__chevron" aria-hidden="true">
        {"\u203a"}
      </span>
    </Link>
  );
}
