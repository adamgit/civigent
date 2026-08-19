import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import {
  partitionRecentDocuments,
  type HomeRecentDocument,
} from "../../pages/home/home-recent-documents";
import {
  HOME_RECENT_DOC_LIMIT,
  HOME_RECENT_SPLIT_MIN_PX,
  HOME_RECENT_WINDOW_OPTIONS,
  type HomeRecentWindowId,
} from "../../pages/home/home-constants";
import { HomeRecentDocumentCard } from "./HomeRecentDocumentCard";

interface HomeRecentDocumentsSectionProps {
  documents: HomeRecentDocument[];
  totalCount: number;
  layoutMode?: DocLayoutMode;
  windowId?: HomeRecentWindowId;
  onWindowChange?: (id: HomeRecentWindowId) => void;
}

function takeRecent(documents: HomeRecentDocument[]): HomeRecentDocument[] {
  return documents.slice(0, HOME_RECENT_DOC_LIMIT);
}

export function HomeRecentDocumentsSection({
  documents,
  totalCount,
  layoutMode = "narrow",
  windowId,
  onWindowChange,
}: HomeRecentDocumentsSectionProps) {
  const rootRef = useRef<HTMLElement>(null);
  const [wideEnoughToSplit, setWideEnoughToSplit] = useState(false);

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
  const mixedDocuments = useMemo(
    () => (splitColumns ? [] : takeRecent(documents)),
    [documents, splitColumns],
  );

  if (totalCount === 0 && layoutMode === "narrow") return null;
  const showToggle = layoutMode === "wide" && windowId != null && onWindowChange != null;
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
        ) : (
          <Link to="/recent-docs" className="home-recent__all">
            All {"\u2192"}
          </Link>
        )}
      </div>
      {totalCount === 0 ? (
        <RecentDocList documents={[]} empty="No recent document changes." />
      ) : columns ? (
        <div className="home-recent__columns">
          <RecentDocColumn
            title="Yours"
            empty="No recent changes of yours."
            documents={takeRecent(columns.yours)}
            showYoursMark={false}
          />
          <RecentDocColumn
            title="Everyone else"
            empty="No recent changes by others."
            documents={takeRecent(columns.others)}
          />
        </div>
      ) : (
        <RecentDocList documents={mixedDocuments} empty="No recent document changes." />
      )}
    </section>
  );
}

function RecentDocColumn({
  title,
  empty,
  documents,
  showYoursMark = true,
}: {
  title: string;
  empty: string;
  documents: HomeRecentDocument[];
  showYoursMark?: boolean;
}) {
  return (
    <div className="home-recent__col">
      <h3 className="home-recent__col-title">{title}</h3>
      <RecentDocList documents={documents} empty={empty} showYoursMark={showYoursMark} />
    </div>
  );
}

function RecentDocList({
  documents,
  empty,
  showYoursMark = true,
}: {
  documents: HomeRecentDocument[];
  empty: string;
  showYoursMark?: boolean;
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
    </div>
  );
}
