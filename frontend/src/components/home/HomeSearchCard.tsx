import { Link } from "react-router-dom";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";

interface HomeSearchCardProps {
  layoutMode?: DocLayoutMode;
}

function SearchGlyph() {
  return (
    <svg className="home-search-card__icon" width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.25" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="10.5" cy="10.5" r="3.4" fill="currentColor" opacity="0.22" />
      <path d="M15.2 15.2L20 20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function HomeSearchCard({ layoutMode: _layoutMode = "narrow" }: HomeSearchCardProps) {
  return (
    <Link to="/search-text" className="home-card home-search-card" aria-label="Search documents">
      <SearchGlyph />
      <span className="home-search-card__label">Search</span>
    </Link>
  );
}
