/**
 * document-presence-constants — the single source of truth for presence-strip
 * timing. The pure reducer/adapter core (P3) schedules exact expiries off these
 * values, and the CSS `recent` fade keyframes (P9) are authored to the SAME
 * durations so the discrete demote/drop and the continuous opacity fade land
 * together. If a value changes here, update the matching CSS animation-duration.
 *
 * Values are milliseconds. `present` is deliberately NOT timed — a `present`
 * badge is a level signal ("has this doc open") that persists until the
 * underlying presence signal itself goes away, so it has no TTL.
 */

/**
 * Human recent-edit window: after a live CRDT edit / unpublished change ends,
 * the human badge fades `active → present` (if still open) or drops, over this
 * span. Short by design (~5s).
 */
export const HUMAN_RECENT_EDIT_TTL_MS = 5_000;

/**
 * Human active-write hold: an accepted content-changing live edit keeps the
 * attached editor's write-lane badge on a timed `active` hold for this span
 * (reset by each newer accepted write); expiry settles back to the attached
 * (passive) floor without a fade.
 */
export const HUMAN_ACTIVE_WRITE_WINDOW_MS = 5_000;

/**
 * Agent read trail: a doc-scoped agent read upserts a `recent` presence-lane
 * badge that fades to gone over this span (~10s). Agents do not hold a lasting
 * `active` rung in the presence lane.
 */
export const AGENT_READ_RECENT_TTL_MS = 10_000;

/**
 * Agent write trail: a proposal/commit against this doc upserts a SEPARATE
 * `recent` write-lane badge that fades to gone over this span (~20s) — longer
 * than the read trail so a commit stays visible after the read trail expires.
 */
export const AGENT_WRITE_RECENT_TTL_MS = 20_000;

/**
 * Human write trail. Humans do not currently drive the write lane; if/when they
 * do, this is the shorter trail to use. Kept centralized alongside the agent
 * value so both write-lane fades stay aligned with their CSS keyframes.
 */
export const HUMAN_WRITE_RECENT_TTL_MS = 10_000;

/**
 * Resolve the `recent`-rung TTL for a given lane + kind. Centralizes the
 * per-mode mapping so the adapter never hardcodes a duration at a call site.
 */
export function recentTtlMsFor(
  lane: "presence" | "write",
  kind: "human" | "agent",
): number {
  if (lane === "write") {
    return kind === "agent" ? AGENT_WRITE_RECENT_TTL_MS : HUMAN_WRITE_RECENT_TTL_MS;
  }
  // presence lane
  return kind === "agent" ? AGENT_READ_RECENT_TTL_MS : HUMAN_RECENT_EDIT_TTL_MS;
}
