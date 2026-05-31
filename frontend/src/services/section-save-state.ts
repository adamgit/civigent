/**
 * Document transport/publish status — slim replacement for the removed
 * per-section receipt save-state machine.
 *
 * The legacy `clean → dirty → received → clean` receipt lifecycle,
 * `RECEIPT_TIMEOUT_MS` timeout derivation, and the document-level `SaveStatus`
 * machine are removed (spec 05-ydoc-lifecycle §"Content Flush" removed,
 * §"Section-Level Persistence Status Indicators": "the document-level
 * `SaveStatus` state machine is removed … the frontend redesign can choose to
 * show transport-failure banners, publish state, or nothing at all").
 *
 * What remains is a single coarse status the topbar surfaces, derived only
 * from the live transport connection state and the document publication-pause
 * flag — no per-fragment receipt vocabulary.
 */

import type { CrdtConnectionState } from "./browser-fragment-replica-store";

export type DocTransportStatus =
  | "idle"           // not editing — nothing to report
  | "synced"         // connected + synced; edits flow to the live Y.Doc
  | "publishing"     // a publication pause is active; editors frozen
  | "connecting"     // initial connect / sync in progress
  | "reconnecting"   // transport dropped, retrying
  | "offline";       // transport failed / disconnected; edits not flowing

export interface DocTransportStatusMeta {
  label: string;
  dotClass: string;
}

export const TRANSPORT_STATUS_META: Record<DocTransportStatus, DocTransportStatusMeta> = {
  idle:         { label: "",                  dotClass: "bg-green-500" },
  synced:       { label: "Up to date",        dotClass: "bg-green-500" },
  publishing:   { label: "Publishing…",  dotClass: "bg-blue-400 animate-[pulse-dot_1.5s_ease-in-out_infinite]" },
  connecting:   { label: "Syncing…",     dotClass: "bg-amber-400 animate-[pulse-dot_1.5s_ease-in-out_infinite]" },
  reconnecting: { label: "Reconnecting…", dotClass: "bg-red-500 animate-[pulse-dot_1.5s_ease-in-out_infinite]" },
  offline:      { label: "Offline — unsaved", dotClass: "bg-red-500" },
};

/**
 * Resolve the single coarse transport/publish status for the topbar.
 * `isEditing` gates whether anything is shown at all (read-only viewers see
 * nothing). `publishPaused` wins over a healthy connection because frozen
 * editors are the user-visible state during a publish attempt.
 */
export function resolveTransportStatus(
  connectionState: CrdtConnectionState,
  publishPaused: boolean,
  isEditing: boolean,
): DocTransportStatus {
  if (!isEditing) return "idle";
  if (connectionState === "error" || connectionState === "disconnected") return "offline";
  if (connectionState === "reconnecting") return "reconnecting";
  if (connectionState === "connecting") return "connecting";
  if (publishPaused) return "publishing";
  return "synced";
}
