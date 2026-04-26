export const DOC_BADGES_STORAGE_KEY = "ks_doc_badges";

const BUILD_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatBuildDate(raw: string): { shortLabel: string; longLabel: string } {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { shortLabel: raw, longLabel: raw };
  }

  const day = pad2(date.getUTCDate());
  const month = BUILD_MONTHS[date.getUTCMonth()];
  const year = pad2(date.getUTCFullYear() % 100);
  const hours = pad2(date.getUTCHours());
  const minutes = pad2(date.getUTCMinutes());

  return {
    shortLabel: `${day}/${month} ${hours}:${minutes}`,
    longLabel: `${day} ${month} ${year} - ${hours}:${minutes}`,
  };
}

export function toCanonicalDocPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function readBadgeDocPaths(): Set<string> {
  try {
    const raw = localStorage.getItem(DOC_BADGES_STORAGE_KEY);
    if (!raw) {
      return new Set<string>();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }
    return new Set(
      parsed
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .map((entry) => toCanonicalDocPath(entry)),
    );
  } catch {
    return new Set<string>();
  }
}

export function writeBadgeDocPaths(paths: Set<string>): void {
  try {
    localStorage.setItem(DOC_BADGES_STORAGE_KEY, JSON.stringify(Array.from(paths)));
  } catch {
    // Ignore storage write failures in constrained environments.
  }
}

// ─── WS event classification ────────────────────────────

export interface WsEventClassification {
  refreshTree: boolean;
  addBadge: string | null;
  showToast: { text: string; docPath: string } | null;
  flashDocPaths?: string[];
  flashWriterType?: string;
}

/**
 * Pure decision function for WS events in AppLayout.
 * Returns what side effects should happen — the caller applies them to state.
 */
export function classifyWsEvent(
  event: { type: string; doc_path?: string; writer_type?: string; writer_display_name?: string; added_doc_paths?: string[] },
  focusedDocPath: string | null,
  tabActive: boolean,
): WsEventClassification {
  const noop: WsEventClassification = { refreshTree: false, addBadge: null, showToast: null };

  if (
    event.type === "dirty:changed"
    || event.type === "writer:dirty-state-changed"
    || event.type === "session:status-changed"
  ) {
    return noop;
  }

  if (event.type === "catalog:changed") {
    return {
      refreshTree: true,
      addBadge: null,
      showToast: null,
      flashDocPaths: event.added_doc_paths,
      flashWriterType: event.writer_type,
    };
  }

  if (event.type === "doc:renamed") {
    return { refreshTree: true, addBadge: null, showToast: null };
  }

  if (event.type !== "content:committed") {
    return noop;
  }

  const committedDocPath = toCanonicalDocPath(event.doc_path ?? "");

  if (event.writer_type !== "agent") {
    return { refreshTree: true, addBadge: null, showToast: null };
  }

  if (focusedDocPath === committedDocPath && tabActive) {
    return { refreshTree: true, addBadge: null, showToast: null };
  }

  const toast = tabActive
    ? { text: `${event.writer_display_name} updated ${committedDocPath}`, docPath: committedDocPath }
    : null;

  return {
    refreshTree: true,
    addBadge: committedDocPath,
    showToast: toast,
  };
}

export function parseRouteDocPath(pathname: string): string | null {
  if (!pathname.startsWith("/docs/")) {
    return null;
  }
  const encodedPath = pathname.slice("/docs/".length);
  if (!encodedPath) {
    return null;
  }
  try {
    return toCanonicalDocPath(decodeURIComponent(encodedPath));
  } catch {
    return toCanonicalDocPath(encodedPath);
  }
}
