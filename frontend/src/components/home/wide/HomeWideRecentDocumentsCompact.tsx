import { Link } from "react-router-dom";
import { docHref } from "../../../app/docs-location";
import {
  HOME_RECENT_WINDOW_OPTIONS,
  recentDocsHref,
  type HomeRecentWindowId,
} from "../../../pages/home/home-constants";
import type { HomeRecentDocument } from "../../../pages/home/home-recent-documents";
import { formatHomeCount, formatHomeShortAge } from "../../../pages/home/home-utils";
import { DocPath } from "../../../types/shared.js";
import { PanelHeader } from "./PanelHeader";
import { SegmentedControl } from "./SegmentedControl";

const COMPACT_LIMIT = 20;
const COMPACT_WINDOW_OPTIONS = HOME_RECENT_WINDOW_OPTIONS.filter(
  (option) => option.id === "7d" || option.id === "30d",
);

interface HomeWideRecentDocumentsCompactProps {
  documents: HomeRecentDocument[];
  totalCount: number;
  windowId: HomeRecentWindowId;
  onWindowChange: (id: HomeRecentWindowId) => void;
  now?: Date;
}

export function HomeWideRecentDocumentsCompact({
  documents,
  totalCount,
  windowId,
  onWindowChange,
  now,
}: HomeWideRecentDocumentsCompactProps) {
  const slice = documents.slice(0, COMPACT_LIMIT);

  return (
    <section className="home-recent-compact" aria-labelledby="recent-documents-heading">
      <PanelHeader
        id="recent-documents-heading"
        title="Recent documents"
        subtitle={totalCount > 0 ? `${formatHomeCount(totalCount)} in ${windowId}` : undefined}
      >
        <SegmentedControl
          label="Document activity timeframe"
          options={COMPACT_WINDOW_OPTIONS.map((option) => ({
            value: option.id,
            label: option.id,
          }))}
          value={windowId}
          onChange={(value) => onWindowChange(value as HomeRecentWindowId)}
        />
        <Link className="panel-header__link" to={recentDocsHref(windowId)}>
          All →
        </Link>
      </PanelHeader>

      {totalCount === 0 ? (
        <p className="home-recent__empty">No recent document changes.</p>
      ) : (
        <div className="home-recent-compact__list">
          {slice.map((document) => (
            <RecentDocumentChip
              key={`${document.docPath}\0${document.writerKind}`}
              document={document}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RecentDocumentChip({
  document: doc,
  now,
}: {
  document: HomeRecentDocument;
  now?: Date;
}) {
  const parsed = DocPath.tryParse(doc.docPath);
  const body = (
    <>
      <i className="home-recent-chip__dot" data-writer-kind={doc.writerKind} aria-hidden="true" />
      <span className="home-recent-chip__name font-body">{doc.title}</span>
      <span className="home-recent-chip__age">{formatHomeShortAge(new Date(doc.timestamp), now)}</span>
    </>
  );
  const className = "home-recent-chip";
  if (!parsed) {
    return (
      <span className={className} data-writer-kind={doc.writerKind}>
        {body}
      </span>
    );
  }
  return (
    <Link className={className} to={docHref(parsed)} data-writer-kind={doc.writerKind}>
      {body}
    </Link>
  );
}
