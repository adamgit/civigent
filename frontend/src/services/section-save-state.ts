/**
 * Document transport/save status — a single coarse status the topbar surfaces.
 *
 * The status is driven off the honest semantic ladder, not internal backend
 * state (human users only care about real boundaries):
 *   connection health → received-by-server → saved-to-proposal → committed-to-canonical.
 * Each rung maps to ack'd knowledge the client holds for a fact:
 *   - connection state          → the live transport
 *   - backend error             → the server reported a materialization / normalization
 *                                 / validation / publish failure (durable, refresh-visible)
 *   - `allReceived` watermark   → every local edit acknowledged received (Guarantee A)
 *   - `hasLocalUncommittedEdits`→ a live inprogress proposal still holds OUR edits (Guarantee B)
 *   - publish pause             → the commit handshake is actively running
 *
 * The ladder distinguishes YOUR work from inbound/remote activity. The two raw
 * inputs that drive a commit are document-GLOBAL: the publish pause runs for
 * ANY commit, and the inprogress proposal can hold a stranger's pending
 * sections. Collapsing those to first-person labels ("Saving…", "All changes
 * saved") falsely claims someone else's work — or work stranded from a previous
 * session — as the current user's. So the local lifecycle (`saving`/`syncing`/
 * `savedToProposal`/`saved`) is gated on the writer-filtered local-edit flags,
 * and inbound activity gets its own neutral states (`updating`/`upToDate`).
 *
 * Saved-to-proposal is a real durable state: the server has written this
 * session's edits into the `inprogress` proposal. It survives refresh (proposal
 * files live on disk in the backend data root) and is a load-bearing checkpoint
 * short of canonical publication. It is NOT an "unsaved" warning state — it
 * gets its own between-yellow-and-green color and a label that names the fact
 * ("Saved · Draft" — Saved owns the green, Draft owns the pending-ness). Warning
 * colors are reserved for genuinely unsaved / failed / blocked / degraded states.
 */

import type { CrdtConnectionState } from "./crdt-provider";

export type DocTransportStatus =
  | "idle"             // not editing, or clean with no local edits this session — nothing to report
  | "saved"            // connected; all of YOUR edits committed to canonical (published)
  | "upToDate"         // inbound update landed / others' pending only — current, but NOT your save
  | "savedToProposal"  // YOUR edits durably reached the `inprogress` proposal, not yet published
  | "syncing"          // YOUR local edits still in flight to the server (not yet acknowledged)
  | "saving"           // a commit (publish pause) is actively running for YOUR edits
  | "updating"         // a commit (publish pause) is running, but not for your edits (server applying an update)
  | "connecting"       // initial connect / sync in progress
  | "reconnecting"     // transport dropped, retrying
  | "offline"          // transport failed / disconnected; edits not flowing
  | "error";           // the server reported a materialization / normalization / validation / publish failure

export interface DocTransportStatusMeta {
  label: string;
  dotClass: string;
}

const PULSE = "animate-[pulse-dot_1.5s_ease-in-out_infinite]";

export const TRANSPORT_STATUS_META: Record<DocTransportStatus, DocTransportStatusMeta> = {
  idle:            { label: "",                                    dotClass: "bg-green-500" },
  saved:           { label: "All changes saved",                   dotClass: "bg-green-500" },
  upToDate:        { label: "Up to date",                          dotClass: "bg-green-500" },
  // Between-yellow-and-green: durable proposal save is not an amber warning. Lime
  // reads as "on the way to green" without collapsing to the "clean" green.
  savedToProposal: { label: "Saved · Draft", dotClass: "bg-lime-500" },
  // True unsaved / in-flight: amber conveys "your work is still at risk here".
  syncing:         { label: "Syncing…",                            dotClass: `bg-amber-400 ${PULSE}` },
  saving:          { label: "Saving…",                             dotClass: `bg-blue-400 ${PULSE}` },
  updating:        { label: "Updating…",                           dotClass: `bg-blue-400 ${PULSE}` },
  connecting:      { label: "Connecting…",                         dotClass: `bg-amber-400 ${PULSE}` },
  reconnecting:    { label: "Reconnecting…",                       dotClass: `bg-red-500 ${PULSE}` },
  offline:         { label: "Offline — unsaved",                   dotClass: "bg-red-500" },
  error:           { label: "Save failed",                         dotClass: "bg-red-500" },
};

/**
 * Resolve the single coarse transport/save status for the topbar. `isEditing`
 * gates whether anything is shown (read-only viewers see nothing). Resolution is
 * weakest-link-first, but every "yours" rung is gated on local-only flags so a
 * commit or pending edit that isn't the current user's never borrows a
 * first-person label:
 *
 *   1. connection problems dominate (offline / reconnecting / connecting)
 *   2. backend-reported error dominates any pending/saved/up-to-date rung —
 *      a durable server failure must not be hidden by "looks fine" local state
 *   3. publish pause → `saving` if it's carrying YOUR edits, else `updating`
 *   4. your edits still in flight → `syncing`
 *   5. your edits durably saved to the proposal, not yet published → `savedToProposal`
 *   6. inbound activity (others' pending / a landed update), no local edits → `upToDate`
 *   7. otherwise → `saved` if you published work this session, else `idle`
 *
 * `hasLocalEdits = !allReceived || hasLocalUncommittedEdits` is the OR of your
 * in-flight and your pending edits; it decides whether a running publish pause
 * is yours. `hasInboundActivity` is "someone else's pending edits exist (or an
 * update just landed) and none are yours". `hadLocalEdits` is the sticky
 * "you committed at least one local edit this session" flag that keeps a clean
 * doc on `saved` rather than collapsing to `idle` — without it, work stranded
 * from a previous session would falsely read "All changes saved" once it commits.
 *
 * `backendError` is the server-reported durable failure signal (materialize,
 * normalize, validate, or publish failed). It is NOT collapsed into a pending /
 * saved / up-to-date rung — the label must remain visible so the user can act.
 * Transport-level problems (offline / reconnecting) still take precedence
 * because reconnecting first is what unblocks the server round trip.
 */
export function resolveTransportStatus(
  connectionState: CrdtConnectionState,
  publishPaused: boolean,
  isEditing: boolean,
  allReceived: boolean,
  hasLocalUncommittedEdits: boolean,
  hasInboundActivity: boolean,
  hadLocalEdits: boolean,
  backendError: string | null,
): DocTransportStatus {
  if (!isEditing) return "idle";
  if (connectionState === "error" || connectionState === "disconnected") return "offline";
  if (connectionState === "reconnecting") return "reconnecting";
  if (connectionState === "connecting") return "connecting";
  // A durable server failure must not be masked by pending / saved / up-to-date.
  if (backendError !== null) return "error";
  const hasLocalEdits = !allReceived || hasLocalUncommittedEdits;
  if (publishPaused) return hasLocalEdits ? "saving" : "updating";
  if (!allReceived) return "syncing";
  if (hasLocalUncommittedEdits) return "savedToProposal";
  if (hasInboundActivity) return "upToDate";
  return hadLocalEdits ? "saved" : "idle";
}
