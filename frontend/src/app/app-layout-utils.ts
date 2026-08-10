import { DocPath } from "../types/shared";
export const SIDEBAR_AUTOHIDE_STORAGE_KEY = "ks_sidebar_autohide";

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

function parseSidebarAutoHideFlag(raw: string | null): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

/**
 * Per-tab preference (sessionStorage) first; otherwise last-writer seed from
 * localStorage. When seeding from localStorage, claim it into sessionStorage
 * so this tab keeps its own value across remounts / back-forward.
 */
export function readSidebarAutoHide(): boolean {
  try {
    const fromSession = parseSidebarAutoHideFlag(sessionStorage.getItem(SIDEBAR_AUTOHIDE_STORAGE_KEY));
    if (fromSession !== null) return fromSession;

    const fromLocal = parseSidebarAutoHideFlag(localStorage.getItem(SIDEBAR_AUTOHIDE_STORAGE_KEY));
    if (fromLocal !== null) {
      sessionStorage.setItem(SIDEBAR_AUTOHIDE_STORAGE_KEY, fromLocal ? "1" : "0");
      return fromLocal;
    }
  } catch {
    // Ignore storage access failures in constrained environments.
  }
  return false;
}

/** Persist for this tab (session) and as the seed for new tabs (local). */
export function writeSidebarAutoHide(value: boolean): void {
  const flag = value ? "1" : "0";
  try {
    sessionStorage.setItem(SIDEBAR_AUTOHIDE_STORAGE_KEY, flag);
  } catch {
    // Ignore sessionStorage failures in constrained environments.
  }
  try {
    localStorage.setItem(SIDEBAR_AUTOHIDE_STORAGE_KEY, flag);
  } catch {
    // Ignore localStorage failures in constrained environments.
  }
}

// ─── WS event classification ────────────────────────────

export interface WsEventClassification {
  refreshTree: boolean;
  addBadge: string | null;
  showToast: { text: string; docPath: DocPath } | null;
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

  // Per-section editor affordance events (`section:pending`/`section:settled`,
  // like the block-state events) ride the JSON app WS but are NOT AppLayout-level
  // triggers (tree refresh / badges / toasts) — they are consumed per-section in
  // useDocumentWebSocket. They return noop here. Unknown event types fall through
  // to the trailing `noop` below regardless.
  if (event.type === "section:pending" || event.type === "section:settled") {
    return noop;
  }

  // `section:edit-rejected` is origin-only and consumed exclusively by the
  // document page (interruptive rejection modal). AppLayout must not refresh
  // the tree, add a badge, or emit a toast for it — those channels would leak
  // the rejection into unrelated navigation UI. Kept alongside the per-section
  // no-op list rather than the classification switch to make the intent
  // explicit.
  if (event.type === "section:edit-rejected") {
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

  const committedDocPath = event.doc_path;
  if (committedDocPath === undefined || !DocPath.isDocPath(committedDocPath)) {
    return noop;
  }

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
