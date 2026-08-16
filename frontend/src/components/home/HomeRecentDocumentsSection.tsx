import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import type { HomeRecentDocument } from "../../pages/home/home-recent-documents";
import {
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

export function HomeRecentDocumentsSection({
  documents,
  totalCount,
  layoutMode = "narrow",
  windowId,
  onWindowChange,
}: HomeRecentDocumentsSectionProps) {
  if (totalCount === 0 && layoutMode === "narrow") return null;
  const showToggle = layoutMode === "wide" && windowId != null && onWindowChange != null;
  return (
    <section className="home-recent" aria-label="Recent documents">
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
      <div className="home-recent__list">
        {documents.length === 0 ? (
          <p className="home-recent__empty">No recent document changes.</p>
        ) : (
          documents.map((doc) => (
            <HomeRecentDocumentCard key={doc.docPath} document={doc} layoutMode={layoutMode} />
          ))
        )}
      </div>
    </section>
  );
}
