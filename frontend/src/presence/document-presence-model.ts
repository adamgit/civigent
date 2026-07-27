/**
 * document-presence-model — the DISCRETE public snapshot for the document
 * presence strip (paper-header badges).
 *
 * This module defines only the shape React renders from. It deliberately carries
 * NO timestamps, WS/awareness types, fragment keys, or opacity values: those are
 * private adapter/CSS concerns (see the reducer core and the CSS keyframes). React
 * re-renders only when this discrete snapshot changes (JSON-dedupe), so anything
 * continuous (opacity fades) must live in CSS, driven off `fadeKey`, not here.
 *
 * A badge exists per (identity, lane): the same actor may appear twice — once in
 * the presence lane and once in the write lane — and the two never merge. Humans
 * render left-aligned, agents right-aligned; `humans` / `agents` are pre-sorted so
 * the render path is a pure map with stable order.
 */

/** Human vs agent actor — drives border token (`--color-accent` vs `--color-agent`). */
export type PresenceKind = "human" | "agent";

/**
 * Which trail a badge belongs to.
 * - `presence` — "is here / was just here" (page-open, live edit, recent agent read).
 * - `write` — "recently committed on this doc" (a separate, longer commit trail).
 */
export type PresenceLane = "presence" | "write";

/**
 * The discrete engagement rung a badge currently sits on. CSS maps each rung to an
 * opacity treatment (see P9): `active` full, `present` fixed-muted, `recent` a
 * one-shot fade. Ordering of priority within a lane is `active` > `recent` > `present`.
 */
export type PresenceEngagement = "active" | "recent" | "present";

/**
 * A single rendered badge. One per (id, lane). Nothing here is continuous or
 * time-based — `fadeKey` is an opaque restart token for the CSS animation only.
 */
export interface PresenceBadge {
  /** Stable actor identity (writer id / agent id). Not shown to the user. */
  readonly id: string;
  /** Full display name (used for tooltip / a11y label). */
  readonly displayName: string;
  /** 1–2 char initials rendered inside the circle. */
  readonly initials: string;
  /** Per-user fill color (CSS color string) for the circle interior. */
  readonly fillColor: string;
  /** Human vs agent — selects the border token family. */
  readonly kind: PresenceKind;
  /** Presence vs write lane — a given actor may hold one badge in each. */
  readonly lane: PresenceLane;
  /** Discrete engagement rung; CSS chooses the opacity treatment from this. */
  readonly engagement: PresenceEngagement;
  /**
   * Opaque restart token. Changes ONLY to tell CSS to restart the `recent` fade
   * from full opacity when fresh evidence arrives. Never interpreted as a time or
   * an ordering; compared solely for inequality across snapshots.
   */
  readonly fadeKey: number;
}

/**
 * The full discrete presence snapshot for one document. Both arrays are pre-sorted
 * by the adapter so rendering is a pure, stable map. Duplicate identities across the
 * two lanes are expected (an agent reading and having just committed shows twice on
 * the same side).
 */
export interface DocumentPresenceModel {
  /** Human badges, left-aligned, pre-sorted for stable render order. */
  readonly humans: readonly PresenceBadge[];
  /** Agent badges, right-aligned, pre-sorted for stable render order. */
  readonly agents: readonly PresenceBadge[];
}

/** An empty snapshot — the initial/no-presence state. */
export const EMPTY_DOCUMENT_PRESENCE_MODEL: DocumentPresenceModel = {
  humans: [],
  agents: [],
};
