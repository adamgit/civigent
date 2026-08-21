import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  HOME_RECENT_WINDOW_OPTIONS,
  HOME_WIDE_LIST_PAGE_SIZE,
  recentDocsHref,
  type HomeRecentWindowId,
} from "../../../pages/home/home-constants";
import type { HomeRecentDocument } from "../../../pages/home/home-recent-documents";
import { HomeWideRecentDocumentRow } from "./HomeWideRecentDocumentRow";
import { HomeWidePager } from "./HomeWidePager";
import { PanelHeader } from "./PanelHeader";
import { SegmentedControl } from "./SegmentedControl";

interface HomeWideRecentDocumentsProps {
  documents: HomeRecentDocument[];
  totalCount: number;
  windowId: HomeRecentWindowId;
  onWindowChange: (id: HomeRecentWindowId) => void;
  now?: Date;
}

export function HomeWideRecentDocuments({
  documents,
  totalCount,
  windowId,
  onWindowChange,
  now,
}: HomeWideRecentDocumentsProps) {
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [windowId]);

  const pageCount = Math.max(1, Math.ceil(documents.length / HOME_WIDE_LIST_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const slice = documents.slice(
    safePage * HOME_WIDE_LIST_PAGE_SIZE,
    safePage * HOME_WIDE_LIST_PAGE_SIZE + HOME_WIDE_LIST_PAGE_SIZE,
  );

  return (
    <section className="home-panel" aria-labelledby="recent-documents-heading">
      <PanelHeader id="recent-documents-heading" title="Recent documents" subtitle="person-authored">
        <SegmentedControl
          label="Document activity timeframe"
          options={HOME_RECENT_WINDOW_OPTIONS.map((option) => ({
            value: option.id,
            label: option.id === "7d" ? "7d" : option.id === "30d" ? "30d" : option.label,
          }))}
          value={windowId}
          onChange={(value) => onWindowChange(value as HomeRecentWindowId)}
        />
        <Link className="panel-header__link" to={recentDocsHref(windowId)}>
          All →
        </Link>
      </PanelHeader>

      <div>
        {totalCount === 0 ? (
          <p className="home-recent__empty" style={{ padding: "14px 20px" }}>
            No recent document changes.
          </p>
        ) : (
          slice.map((document) => (
            <HomeWideRecentDocumentRow key={document.docPath} document={document} now={now} />
          ))
        )}
        <HomeWidePager
          page={safePage}
          pageSize={HOME_WIDE_LIST_PAGE_SIZE}
          total={documents.length}
          setPage={setPage}
          label="Recent documents pages"
        />
      </div>
    </section>
  );
}
