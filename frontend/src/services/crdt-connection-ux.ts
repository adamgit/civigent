/**
 * Connection-state → UX mapping for the editor CRDT transport.
 *
 * The raw provider states (crdt-provider.ts) are collapsed into the coarse
 * phases the user actually cares about, and every degraded phase drives the SAME
 * three surfaces so no failure mode is silently invisible:
 *   - the topbar pill (section-save-state.ts already handles each state),
 *   - the document-level connection banner,
 *   - the per-section read-only + dimmed affordance.
 *
 * Why both `connecting` and `reconnecting` are degraded, not just `reconnecting`:
 * the provider only enters `connecting` on the FIRST attempt of a session
 * (`reconnectAttempts === 0`); a socket that drops after going live cycles
 * `error`/`reconnecting` instead. So which phase you observe when the server is
 * down depends on whether the server was ever reached this session — clicking
 * "edit" against an already-dead backend sits in `connecting` (and can hang
 * there), while a server that dies mid-session lands in `reconnecting`. Both mean
 * "edits are not flowing"; both must show the banner and pause the editor.
 */

import type { CrdtConnectionState } from "./crdt-provider";
import type { ObserverConnectionState } from "./observer-crdt-provider";

/** Coarse connection phase. `live` is the only healthy phase. */
export type CrdtConnectionPhase = "live" | "connecting" | "reconnecting" | "offline";

export function crdtConnectionPhase(state: CrdtConnectionState): CrdtConnectionPhase {
  switch (state) {
    case "connected":
      return "live";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "error":
    case "disconnected":
      return "offline";
  }
}

/**
 * True when the transport is not live: the editor must go read-only + dimmed and
 * the connection banner must show. Covers first-connect (`connecting`) AND
 * dropped-mid-session (`reconnecting`/`error`/`disconnected`).
 */
export function isCrdtDegraded(state: CrdtConnectionState): boolean {
  return crdtConnectionPhase(state) !== "live";
}

export interface CrdtBannerInfo {
  /** Visual tone for the document-level banner. */
  tone: "amber" | "red";
  /** Banner copy. */
  message: string;
  /** Short label for the in-section "editing paused" affordance. */
  sectionLabel: string;
}

/** Banner + section messaging for a degraded connection; null when live. */
export function crdtBannerInfo(state: CrdtConnectionState): CrdtBannerInfo | null {
  switch (crdtConnectionPhase(state)) {
    case "live":
      return null;
    case "connecting":
      return {
        tone: "amber",
        message: "Connecting to server…",
        sectionLabel: "Connecting — editing paused",
      };
    case "reconnecting":
      return {
        tone: "amber",
        message: "Connection lost — reconnecting…",
        sectionLabel: "Reconnecting — editing paused",
      };
    case "offline":
      return {
        tone: "red",
        message: "Offline — changes won’t be saved",
        sectionLabel: "Offline — editing paused",
      };
  }
}

/**
 * Document-level connection banner for EITHER mode:
 *   - editing → the editor transport's full state (incl. offline/error),
 *     via {@link crdtBannerInfo}.
 *   - viewing → the observer's state, but ONLY the active degraded phases
 *     (`connecting`/`reconnecting`) warrant a banner. For an observer,
 *     `disconnected` means "no observer running" (initial / stopped) and
 *     `connected` is healthy — neither is a failure. A viewer holds no local
 *     edits, so the copy never claims unsaved changes.
 *
 * This is what stops a server loss while only viewing from being silently lost:
 * the observer reconnects forever, and this surfaces that as a banner.
 */
export function connectionBannerInfo(
  isEditing: boolean,
  editorState: CrdtConnectionState,
  observerState: ObserverConnectionState,
): CrdtBannerInfo | null {
  if (isEditing) return crdtBannerInfo(editorState);
  switch (observerState) {
    case "connecting":
      return {
        tone: "amber",
        message: "Connecting to server…",
        sectionLabel: "Connecting…",
      };
    case "reconnecting":
      return {
        tone: "amber",
        message: "Connection lost — live updates paused, reconnecting…",
        sectionLabel: "Reconnecting…",
      };
    default:
      return null; // connected (live) or disconnected (no observer running)
  }
}
