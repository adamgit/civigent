import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import {
  partitionRecentDocuments,
  type HomeRecentDocument,
} from "../../pages/home/home-recent-documents";
import {
  HOME_RECENT_SPLIT_MIN_PX,
  HOME_RECENT_WINDOW_DEFAULT,
  HOME_RECENT_WINDOW_OPTIONS,
  homeRecentPageSize,
  recentDocsHref,
  type HomeRecentWindowId,
} from "../../pages/home/home-constants";
import { HomeRecentDocumentCard } from "./HomeRecentDocumentCard";

interface HomeRecentDocumentsSectionProps {
  documents: HomeRecentDocument[];
  totalCount: number;
  layoutMode?: DocLayoutMode;
  windowId?: HomeRecentWindowId;
  onWindowChange?: (id: HomeRecentWindowId) => void;
  showAllLink?: boolean;
  hideWhenEmpty?: boolean;
}

function usePagedItems<T>(items: T[], pageSize: number, resetKey: string): {
  page: number;
  setPage: (page: number) => void;
  slice: T[];
  total: number;
  pageSize: number;
} {
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [resetKey]);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  return {
    page: safePage,
    setPage,
    slice: items.slice(safePage * pageSize, safePage * pageSize + pageSize),
    total: items.length,
    pageSize,
  };
}

export function HomeRecentDocumentsSection({
  documents,
  totalCount,
  layoutMode = "narrow",
  windowId,
  onWindowChange,
  showAllLink = true,
  hideWhenEmpty,
}: HomeRecentDocumentsSectionProps) {
  const rootRef = useRef<HTMLElement>(null);
  const [wideEnoughToSplit, setWideEnoughToSplit] = useState(false);
  const pageSize = homeRecentPageSize(layoutMode);
  const pageResetKey = windowId ?? HOME_RECENT_WINDOW_DEFAULT;

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setWideEnoughToSplit(el.clientWidth >= HOME_RECENT_SPLIT_MIN_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const splitColumns = layoutMode === "wide" && wideEnoughToSplit;
  const columns = useMemo(
    () => (splitColumns ? partitionRecentDocuments(documents) : null),
    [documents, splitColumns],
  );
  const mixed = usePagedItems(splitColumns ? [] : documents, pageSize, pageResetKey);
  const yours = usePagedItems(columns?.yours ?? [], pageSize, pageResetKey);
  const others = usePagedItems(columns?.others ?? [], pageSize, pageResetKey);

  const shouldHideEmpty = hideWhenEmpty ?? layoutMode === "narrow";
  if (totalCount === 0 && shouldHideEmpty) return null;
  const showToggle = windowId != null && onWindowChange != null;
  return (
    <section
      ref={rootRef}
      className={`home-recent${splitColumns ? " home-recent--split" : ""}`}
      aria-label="Recent documents"
    >
      <div className="home-recent__head">
        <h2 className="home-section-label">
          Recent documents {"\u00b7"} {totalCount}
        </h2>
        <div className="home-recent__actions">
          {showToggle ? (
            <div className="home-window-toggle" role="radiogroup" aria-label="Recent documents window">
              {HOME_RECENT_WINDOW_OPTIONS.map((option) => {
                const active = option.id === windowId;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`home-window-toggle__btn${active ? " home-window-toggle__btn--active" : ""}`}
                    onClick={() => onWindowChange(option.id)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          ) : null}
          {showAllLink ? (
            <Link
              to={recentDocsHref(windowId ?? HOME_RECENT_WINDOW_DEFAULT)}
              className="home-recent__all"
            >
              All {"\u2192"}
            </Link>
          ) : null}
        </div>
      </div>
      {totalCount === 0 ? (
        <RecentDocList documents={[]} empty="No recent document changes." />
      ) : columns ? (
        <div className="home-recent__columns">
          <RecentDocColumn
            title="Yours"
            empty="No recent changes of yours."
            documents={yours.slice}
            showYoursMark={false}
            pager={yours}
          />
          <RecentDocColumn
            title="Everyone else"
            empty="No recent changes by others."
            documents={others.slice}
            pager={others}
          />
        </div>
      ) : (
        <RecentDocList
          documents={mixed.slice}
          empty="No recent document changes."
          pager={mixed}
        />
      )}
    </section>
  );
}

interface RecentDocPagerModel {
  page: number;
  setPage: (page: number) => void;
  total: number;
  pageSize: number;
}

function RecentDocColumn({
  title,
  empty,
  documents,
  showYoursMark = true,
  pager,
}: {
  title: string;
  empty: string;
  documents: HomeRecentDocument[];
  showYoursMark?: boolean;
  pager: RecentDocPagerModel;
}) {
  return (
    <div className="home-recent__col">
      <h3 className="home-recent__col-title">{title}</h3>
      <RecentDocList
        documents={documents}
        empty={empty}
        showYoursMark={showYoursMark}
        pager={pager}
      />
    </div>
  );
}

function RecentDocList({
  documents,
  empty,
  showYoursMark = true,
  pager,
}: {
  documents: HomeRecentDocument[];
  empty: string;
  showYoursMark?: boolean;
  pager?: RecentDocPagerModel;
}) {
  return (
    <div className="home-recent__list">
      {documents.length === 0 ? (
        <p className="home-recent__empty">{empty}</p>
      ) : (
        documents.map((doc) => (
          <HomeRecentDocumentCard
            key={doc.docPath}
            document={doc}
            showYoursMark={showYoursMark}
          />
        ))
      )}
      {pager ? <RecentDocPager {...pager} /> : null}
    </div>
  );
}

function RecentDocPager({ page, pageSize, total, setPage }: RecentDocPagerModel) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const start = page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="home-recent__pager" aria-label="Recent documents pages">
      <button
        type="button"
        className="home-recent__pager-btn"
        disabled={page <= 0}
        onClick={() => setPage(page - 1)}
      >
        Previous
      </button>
      <span className="home-recent__pager-status">
        {start}{"\u2013"}{end} of {total}
      </span>
      <button
        type="button"
        className="home-recent__pager-btn"
        disabled={page >= pageCount - 1}
        onClick={() => setPage(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
