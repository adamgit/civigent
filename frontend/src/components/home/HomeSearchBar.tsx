import { SEARCH_MAX_RESULTS } from "../../pages/search/search-request-defaults";

export function HomeSearchBar() {
  return (
    <form action="/search-text" method="GET" className="home-search-bar" aria-label="Search documents">
      <input type="hidden" name="root" value="/" />
      <input type="hidden" name="case_sensitive" value="false" />
      <input type="hidden" name="max_results" value={SEARCH_MAX_RESULTS} />
      <input type="hidden" name="context_bytes" value="100" />
      <input
        type="text"
        name="pattern"
        placeholder="Search /api/search"
        className="input-field home-search-bar__input"
        required
      />
      <select name="syntax" defaultValue="literal" className="input-field home-search-bar__syntax">
        <option value="literal">Plaintext</option>
        <option value="regexp">Regexp</option>
      </select>
      <button type="submit" className="btn-secondary home-search-bar__submit">
        Search
      </button>
    </form>
  );
}
