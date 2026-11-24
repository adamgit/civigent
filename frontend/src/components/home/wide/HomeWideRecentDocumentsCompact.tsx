import { useState } from "react";
import { Link } from "react-router-dom";
import { docHref } from "../../../app/docs-location";
import {
  HOME_RECENT_WINDOW_OPTIONS,
  readHomeRecentExpanded,
  recentDocsHref,
  writeHomeRecentExpanded,
  type HomeRecentWindowId,
} from "../../../pages/home/home-constants";
import type { HomeRecentDocument, HomeRecentDocumentsData } from "../../../pages/home/home-recent-documents";
import { formatHomeCount, formatHomeShortAge } from "../../../pages/home/home-utils";
import { DocPath } from "../../../types/shared.js";
import type { Feed } from "../../../utils/feed-state";
import { FeedView } from "../../feed/FeedView";
import { SegmentedControl } from "./SegmentedControl";

const COMPACT_LIMIT = 20;
const COMPACT_WINDOW_OPTIONS = HOME_RECENT_WINDOW_OPTIONS.filter(
  (option) => option.id === "7d" || option.id === "30d",
);

interface HomeWideRecentDocumentsCompactProps {
  recent: Feed<HomeRecentDocumentsData>;
  windowId: HomeRecentWindowId;
  onWindowChange: (id: HomeRecentWindowId) => void;
  now?: Date;
}

export function HomeWideRecentDocumentsCompact({
  recent,
  windowId,
  onWindowChange,
  now,
}: HomeWideRecentDocumentsCompactProps) {
  const [expanded, setExpanded] = useState(readHomeRecentExpanded);

  const toggle = () => {
    setExpanded((current) => {
      const next = !current;
      writeHomeRecentExpanded(next);
      return next;
    });
  };

  return (
    <section
      className={`home-recent-compact${expanded ? "" : " home-recent-compact--collapsed"}`}
      aria-labelledby="recent-documents-heading"
    >
      <div className="panel-header">
        <button
          type="button"
          className="home-recent-compact__toggle"
          aria-expanded={expanded}
          aria-controls="recent-documents-body"
          onClick={toggle}
        >
          <h2 id="recent-documents-heading" className="panel-header__title font-body">
            Recent documents
          </h2>
          <span className="home-recent-compact__chevron" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        {expanded ? (
          <>
            {recent.status === "loaded" && recent.data.totalCount > 0 ? (
              <span className="panel-header__subtitle">
                {formatHomeCount(recent.data.totalCount)} in {windowId}
              </span>
            ) : null}
            <span className="panel-header__spacer" />
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
          </>
        ) : null}
      </div>

      {expanded ? (
        <div id="recent-documents-body">
          <FeedView feed={recent} subject="recent documents">
            {({ documents, totalCount }) =>
              totalCount === 0 ? (
                <p className="home-recent__empty">No recent document changes.</p>
              ) : (
                <div className="home-recent-compact__list">
                  {documents.slice(0, COMPACT_LIMIT).map((document) => (
                    <RecentDocumentChip
                      key={`${document.docPath}\0${document.writerKind}`}
                      document={document}
                      now={now}
                    />
                  ))}
                </div>
              )
            }
          </FeedView>
        </div>
      ) : null}
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
