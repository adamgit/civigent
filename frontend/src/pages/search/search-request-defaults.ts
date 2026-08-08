/**
 * Defaults every entry point into `/search-text` must agree on.
 *
 * The results page draws a map of where the hits live, and that map is built
 * from whatever the API returned. If one entry point asked for 20 results while
 * the page's own fallback asked for more, the same query would draw two
 * different — and equally confident-looking — maps. So the value lives here and
 * every search form posts it.
 */
export const SEARCH_MAX_RESULTS = "200";
