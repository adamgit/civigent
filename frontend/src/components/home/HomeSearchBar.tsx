import { SEARCH_MAX_RESULTS } from "../../pages/search/search-request-defaults";

interface HomeSearchBarProps {
  compact?: boolean;
}

export function HomeSearchBar({ compact = false }: HomeSearchBarProps) {
  return (
    <form
      action="/search-text"
      method="GET"
      className={compact ? "home-search-bar home-search-bar--compact" : "home-search-bar"}
      aria-label="Search documents"
    >
      <input type="hidden" name="root" value="/" />
      <input type="hidden" name="case_sensitive" value="false" />
      <input type="hidden" name="max_results" value={SEARCH_MAX_RESULTS} />
      <input type="hidden" name="context_bytes" value="100" />
      <input type="hidden" name="syntax" value="literal" />
      <input
        type="text"
        name="pattern"
        placeholder={compact ? "Search documents" : "Search..."}
        className="input-field home-search-bar__input"
        required
      />
    </form>
  );
}
