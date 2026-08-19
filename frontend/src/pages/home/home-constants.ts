/** Rolling window used by active-folder ratios and the default recent-doc view. */
export const HOME_RECENT_WINDOW_DAYS = 7;

/** First page on narrow/mobile; further documents are one tap away. */
export const HOME_RECENT_PAGE_SIZE_NARROW = 10;
/** First page on wide; a typical 7-day list is a couple of pages, not nine. */
export const HOME_RECENT_PAGE_SIZE_WIDE = 24;
export const HOME_AGENT_ROW_LIMIT = 8;

/**
 * When the recent-documents section is at least this wide, cards split into
 * Yours / Everyone else columns instead of one mixed list. Significantly
 * wider than the 750px card cap so a second column is usable.
 */
export const HOME_RECENT_SPLIT_MIN_PX = 1000;

/** Fetch the widest toggle option so 24h / 7d / 30d can filter client-side. */
export const HOME_ACTIVITY_FETCH_DAYS = 30;
export const HOME_ACTIVITY_FETCH_LIMIT = 500;

export const HOME_RECENT_WINDOW_OPTIONS = [
  { id: "24h", label: "24h", days: 1 },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
] as const;

export type HomeRecentWindowId = (typeof HOME_RECENT_WINDOW_OPTIONS)[number]["id"];

export const HOME_RECENT_WINDOW_DEFAULT: HomeRecentWindowId = "7d";
export const HOME_RECENT_WINDOW_STORAGE_KEY = "ks_home_recent_window";

export function parseHomeRecentWindowId(value: string | null | undefined): HomeRecentWindowId | null {
  if (value == null) return null;
  const match = HOME_RECENT_WINDOW_OPTIONS.find((option) => option.id === value);
  return match?.id ?? null;
}

export function readHomeRecentWindow(): HomeRecentWindowId {
  try {
    return parseHomeRecentWindowId(localStorage.getItem(HOME_RECENT_WINDOW_STORAGE_KEY))
      ?? HOME_RECENT_WINDOW_DEFAULT;
  } catch {
    return HOME_RECENT_WINDOW_DEFAULT;
  }
}

export function homeRecentPageSize(layoutMode: "wide" | "narrow"): number {
  return layoutMode === "narrow" ? HOME_RECENT_PAGE_SIZE_NARROW : HOME_RECENT_PAGE_SIZE_WIDE;
}

export function recentDocsHref(windowId: HomeRecentWindowId = HOME_RECENT_WINDOW_DEFAULT): string {
  return `/recent-docs?window=${windowId}`;
}

export function writeHomeRecentWindow(id: HomeRecentWindowId): void {
  try {
    localStorage.setItem(HOME_RECENT_WINDOW_STORAGE_KEY, id);
  } catch {
    /* Ignore localStorage failures in constrained environments. */
  }
}

export function homeRecentWindowDays(id: HomeRecentWindowId): number {
  const match = HOME_RECENT_WINDOW_OPTIONS.find((option) => option.id === id);
  return match?.days ?? HOME_RECENT_WINDOW_DAYS;
}

export const CIVIGENT_GITHUB_URL = "https://github.com/adamgit/civigent";
