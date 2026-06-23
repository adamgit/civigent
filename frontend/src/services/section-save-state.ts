/**
 * Document transport/save status — a single coarse status the topbar surfaces.
 *
 * The status is driven off the honest semantic ladder, not internal backend
 * state (human users only care about real boundaries):
 *   connection health → received-by-server → committed-to-canonical.
 * Each rung maps to ack'd knowledge the client holds for a fact:
 *   - connection state          → the live transport
 *   - `allReceived` watermark   → every local edit acknowledged received (Guarantee A)
 *   - `hasLocalUncommittedEdits`→ a live inprogress proposal still holds OUR edits (Guarantee B)
 *   - publish pause             → the commit handshake is actively running
 *
 * Crucially the ladder distinguishes YOUR work from inbound/remote activity. The
 * two raw inputs that drive a commit are document-GLOBAL: the publish pause runs
 * for ANY commit, and the inprogress proposal can hold a stranger's pending
 * sections. Collapsing those to first-person labels ("Saving…", "All changes
 * saved") falsely claims someone else's work — or work stranded from a previous
 * session — as the current user's. So the local lifecycle (`saving`/`syncing`/
 * `receivedNotSaved`/`saved`) is gated on the writer-filtered local-edit flags,
 * and inbound activity gets its own neutral states (`updating`/`upToDate`).
 */

import type { CrdtConnectionState } from "./browser-fragment-replica-store";

export type DocTransportStatus =
  | "idle"             // not editing, or clean with no local edits this session — nothing to report
  | "saved"            // connected; all of YOUR edits received AND committed to canonical
  | "upToDate"         // inbound update landed / others' pending only — current, but NOT your save
  | "receivedNotSaved" // all of YOUR edits received by server, but not yet committed (refresh-vulnerable)
  | "syncing"          // YOUR local edits still in flight to the server
  | "saving"           // a commit (publish pause) is actively running for YOUR edits
  | "updating"         // a commit (publish pause) is running, but not for your edits (server applying an update)
  | "connecting"       // initial connect / sync in progress
  | "reconnecting"     // transport dropped, retrying
  | "offline";         // transport failed / disconnected; edits not flowing

export interface DocTransportStatusMeta {
  label: string;
  dotClass: string;
}

const PULSE = "animate-[pulse-dot_1.5s_ease-in-out_infinite]";

export const TRANSPORT_STATUS_META: Record<DocTransportStatus, DocTransportStatusMeta> = {
  idle:             { label: "",                    dotClass: "bg-green-500" },
  saved:            { label: "All changes saved",   dotClass: "bg-green-500" },
  upToDate:         { label: "Up to date",          dotClass: "bg-green-500" },
  receivedNotSaved: { label: "Received — not yet saved", dotClass: "bg-amber-400" },
  syncing:          { label: "Syncing…",            dotClass: `bg-amber-400 ${PULSE}` },
  saving:           { label: "Saving…",             dotClass: `bg-blue-400 ${PULSE}` },
  updating:         { label: "Updating…",           dotClass: `bg-blue-400 ${PULSE}` },
  connecting:       { label: "Connecting…",         dotClass: `bg-amber-400 ${PULSE}` },
  reconnecting:     { label: "Reconnecting…",       dotClass: `bg-red-500 ${PULSE}` },
  offline:          { label: "Offline — unsaved",   dotClass: "bg-red-500" },
};

/**
 * Resolve the single coarse transport/save status for the topbar. `isEditing`
 * gates whether anything is shown (read-only viewers see nothing). Resolution is
 * weakest-link-first, but every "yours" rung is gated on local-only flags so a
 * commit or pending edit that isn't the current user's never borrows a
 * first-person label:
 *
 *   1. connection problems dominate (offline / reconnecting / connecting)
 *   2. publish pause → `saving` if it's carrying YOUR edits, else `updating`
 *   3. your edits still in flight → `syncing`
 *   4. your edits received but not yet committed → `receivedNotSaved`
 *   5. inbound activity (others' pending / a landed update), no local edits → `upToDate`
 *   6. otherwise → `saved` if you committed work this session, else `idle`
 *
 * `hasLocalEdits = !allReceived || hasLocalUncommittedEdits` is the OR of your
 * in-flight and your pending edits; it decides whether a running publish pause is
 * yours. `hasInboundActivity` is "someone else's pending edits exist (or an
 * update just landed) and none are yours". `hadLocalEdits` is the sticky
 * "you committed at least one local edit this session" flag that keeps a clean
 * doc on `saved` rather than collapsing to `idle` — without it, work stranded
 * from a previous session would falsely read "All changes saved" once it commits.
 */
export function resolveTransportStatus(
  connectionState: CrdtConnectionState,
  publishPaused: boolean,
  isEditing: boolean,
  allReceived: boolean,
  hasLocalUncommittedEdits: boolean,
  hasInboundActivity: boolean,
  hadLocalEdits: boolean,
): DocTransportStatus {
  if (!isEditing) return "idle";
  if (connectionState === "error" || connectionState === "disconnected") return "offline";
  if (connectionState === "reconnecting") return "reconnecting";
  if (connectionState === "connecting") return "connecting";
  const hasLocalEdits = !allReceived || hasLocalUncommittedEdits;
  if (publishPaused) return hasLocalEdits ? "saving" : "updating";
  if (!allReceived) return "syncing";
  if (hasLocalUncommittedEdits) return "receivedNotSaved";
  if (hasInboundActivity) return "upToDate";
  return hadLocalEdits ? "saved" : "idle";
}
