import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";
import type { HomeRecentDocument } from "../../pages/home/home-recent-documents";
import { HomeRecentDocumentCard } from "./HomeRecentDocumentCard";

interface HomeRecentDocumentsSectionProps {
  documents: HomeRecentDocument[];
  totalCount: number;
  layoutMode?: DocLayoutMode;
}

export function HomeRecentDocumentsSection({
  documents,
  totalCount,
  layoutMode = "narrow",
}: HomeRecentDocumentsSectionProps) {
  if (totalCount === 0) return null;
  return (
    <section className="home-recent" aria-label="Recent documents">
      <div className="home-recent__head">
        <h2 className="home-section-label">
          Recent documents {"\u00b7"} {totalCount}
        </h2>
        <Link to="/recent-docs" className="home-recent__all">
          All {"\u2192"}
        </Link>
      </div>
      <div className="home-recent__list">
        {documents.map((doc) => (
          <HomeRecentDocumentCard key={doc.docPath} document={doc} layoutMode={layoutMode} />
        ))}
      </div>
    </section>
  );
}
