import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import { docHref } from "../../app/docs-location";
import { DocPath } from "../../types/shared.js";
import type { HomeDocChangeKind, HomeRecentDocument } from "../../pages/home/home-recent-documents";
import { formatHomeTime } from "../../pages/home/home-time";

interface HomeRecentDocumentCardProps {
  document: HomeRecentDocument;
  layoutMode?: DocLayoutMode;
}

const BADGE_LABEL: Record<HomeDocChangeKind, string> = {
  rewritten: "Rewritten",
  added: "Added",
  moved: "Moved",
};

export function HomeRecentDocumentCard({
  document: doc,
  layoutMode: _layoutMode = "narrow",
}: HomeRecentDocumentCardProps) {
  const parsed = DocPath.tryParse(doc.docPath);
  const body = (
    <>
      {doc.yours ? <span className="home-doc-card__yours-bar" aria-hidden="true" /> : null}
      <div className="home-doc-card__title-row">
        <span className="home-doc-card__title">{doc.title}</span>
        {doc.yours ? <span className="home-doc-card__yours">YOURS</span> : null}
      </div>
      <div className="home-doc-card__meta">
        {doc.folderPrefix} {"\u00b7"} {doc.writerName} {"\u00b7"} {formatHomeTime(doc.timestamp, "compact")}
      </div>
      {doc.changes.length > 0 ? (
        <div className="home-doc-card__changes">
          {doc.changes.map((change) => (
            <div key={change.kind} className="home-doc-change">
              <span className={`home-doc-change__badge home-doc-change__badge--${change.kind}`}>
                {BADGE_LABEL[change.kind]}
              </span>
              <span className="home-doc-change__text">{change.headings.join(", ")}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );

  const className = `home-card home-doc-card${doc.yours ? " home-doc-card--yours" : ""}`;
  if (!parsed) {
    return <div className={className}>{body}</div>;
  }
  return (
    <Link to={docHref(parsed)} className={className}>
      {body}
    </Link>
  );
}
