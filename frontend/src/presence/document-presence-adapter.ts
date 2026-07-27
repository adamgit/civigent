/**
 * document-presence-adapter — the stateful, effectful wrapper around the pure
 * core ({@link ./document-presence-core}). It owns the clock and a SINGLE
 * timeout armed at the next `recent` deadline (AppLayout tree-flash style — no
 * 1s poll), emits a new discrete snapshot only when the serialized snapshot
 * changes, and recomputes from stored deadlines on tab visibility/focus so a
 * throttled background-tab timer can never leave a stale `recent` badge behind.
 *
 * Signal-specific mapping (human presence, agent read, write-lane) lives in
 * P5–P7 as thin methods that translate a domain signal into the generic
 * evidence ops here (`present` / `clearPresent` / `active` / `recent` /
 * `clearPulse`). This class knows only the mechanics.
 */

import {
  EMPTY_INTERNAL_STATE,
  clearPresent as coreClearPresent,
  clearPulse as coreClearPulse,
  expireDue,
  markActive,
  markActiveFor,
  markPresent,
  markRecent,
  nextExpiryMs,
  reconcileHumanPresence,
  reconcileLaneFloors,
  serializeSnapshot,
  toSnapshot,
  type BadgeIdentity,
  type PresenceInternalState,
} from "./document-presence-core";
import type { PresenceKind, PresenceLane } from "./document-presence-model";
import {
  AGENT_READ_RECENT_TTL_MS,
  HUMAN_RECENT_EDIT_TTL_MS,
  recentTtlMsFor,
} from "./document-presence-constants";
import {
  EMPTY_DOCUMENT_PRESENCE_MODEL,
  type DocumentPresenceModel,
} from "./document-presence-model";

/** Notified with the new discrete snapshot whenever (and only when) it changes. */
export type PresenceSnapshotListener = (model: DocumentPresenceModel) => void;

/**
 * The clock + timer + tab-lifecycle surface the adapter depends on. Injectable so
 * the scheduler is unit-testable with fake time and no real DOM; the default
 * binds to `Date.now()`, `window.setTimeout`, and the document visibility/focus
 * events.
 */
export interface PresenceEnvironment {
  now(): number;
  /** Arm a one-shot timer; returns a canceller. */
  schedule(cb: () => void, delayMs: number): () => void;
  /**
   * Subscribe to "tab became visible / window focused" so the adapter can
   * recompute from stored deadlines. Returns an unsubscribe. Optional — a
   * headless environment may omit it.
   */
  onWake?(cb: () => void): () => void;
}

/** Small epsilon so a timer fires just AFTER a deadline, never a tick before it. */
const EXPIRY_EPSILON_MS = 10;

/**
 * Repeated complete snapshots re-derive the same underlying occurrence with up
 * to ~1s of `seconds_ago` rounding jitter; occurrences within this window of the
 * last applied evidence are the SAME event and must not restart a fade.
 */
const REPEATED_EVIDENCE_TOLERANCE_MS = 2_000;

function defaultEnvironment(): PresenceEnvironment {
  return {
    now: () => Date.now(),
    schedule: (cb, delayMs) => {
      const id = window.setTimeout(cb, delayMs);
      return () => window.clearTimeout(id);
    },
    onWake: (cb) => {
      const onVisible = () => {
        if (document.visibilityState === "visible") cb();
      };
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", cb);
      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", cb);
      };
    },
  };
}

export class DocumentPresenceAdapter {
  private state: PresenceInternalState = EMPTY_INTERNAL_STATE;
  private cancelTimer: (() => void) | null = null;
  private cancelWake: (() => void) | null = null;
  private lastSerialized = serializeSnapshot(EMPTY_DOCUMENT_PRESENCE_MODEL);
  private lastSnapshot: DocumentPresenceModel = EMPTY_DOCUMENT_PRESENCE_MODEL;
  private listener: PresenceSnapshotListener | null = null;
  /** Last evidence token applied per (id, lane) for the recent-only lanes. */
  private readonly lastEvidenceToken = new Map<string, number>();

  constructor(private readonly env: PresenceEnvironment = defaultEnvironment()) {
    if (this.env.onWake) {
      this.cancelWake = this.env.onWake(() => this.recomputeFromDeadlines());
    }
  }

  /** The current discrete snapshot (referentially stable until it changes). */
  snapshot(): DocumentPresenceModel {
    return this.lastSnapshot;
  }

  /** The adapter's clock, for callers deriving occurrence times from wire ages. */
  nowMs(): number {
    return this.env.now();
  }

  /**
   * Register the single snapshot listener (the React hook). Immediately emits the
   * current snapshot is NOT done here — the hook seeds from {@link snapshot}. Returns
   * an unsubscribe.
   */
  subscribe(listener: PresenceSnapshotListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** Tear down timers and tab listeners. Idempotent. */
  dispose(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    if (this.cancelWake) {
      this.cancelWake();
      this.cancelWake = null;
    }
    this.listener = null;
  }

  // ---- generic evidence ops (mapped onto by P5–P7) -------------------------

  /** Set the persistent `present` floor for an actor. */
  present(identity: BadgeIdentity): void {
    this.apply(markPresent(this.state, identity));
  }

  /** Clear the `present` floor; badge survives only if a pulse still holds. */
  clearPresent(identity: BadgeIdentity): void {
    this.apply(coreClearPresent(this.state, identity));
  }

  /** Mark the actor `active` (steady, untimed hold). */
  active(identity: BadgeIdentity): void {
    this.apply(markActive(this.state, identity));
  }

  /**
   * Mark the actor `active` for `remainingMs`, tracked by the same single
   * next-expiry scheduler as `recent` fades. A newer call resets the deadline;
   * expiry clears only the pulse so the badge settles to its floor. Deadlines
   * never reach the public snapshot.
   */
  activeFor(identity: BadgeIdentity, remainingMs: number): void {
    if (remainingMs <= 0) return;
    this.apply(markActiveFor(this.state, identity, remainingMs, this.env.now()));
  }

  /** (Re)start a `recent` fade window of `ttlMs`, bumping the CSS `fadeKey`. */
  recent(identity: BadgeIdentity, ttlMs: number): void {
    this.apply(markRecent(this.state, identity, ttlMs, this.env.now()));
  }

  /** Clear any transient pulse, settling to the floor (or removing the badge). */
  clearPulse(identity: BadgeIdentity): void {
    this.apply(coreClearPulse(this.state, identity));
  }

  // ---- signal mapping (P5–P7) ----------------------------------------------

  /**
   * P5 — reconcile the human presence lane against the CURRENT full sets of
   * doc-open and actively-editing humans. Safe to call every render: idempotent
   * for unchanged sets (no `fadeKey` bump), and a human leaving the active set is
   * demoted to a `recent` fade exactly once. Identities MUST carry
   * `lane: "presence"` and `kind: "human"`.
   */
  syncHumanPresence(
    presentHumans: readonly BadgeIdentity[],
    activeHumans: readonly BadgeIdentity[],
  ): void {
    this.apply(
      reconcileHumanPresence(
        this.state,
        presentHumans,
        activeHumans,
        HUMAN_RECENT_EDIT_TTL_MS,
        this.env.now(),
      ),
    );
  }

  /**
   * Reconcile the persistent floors of one (lane, kind) against the CURRENT
   * full set — attached-editor and agent-draft write-lane floors. Idempotent
   * for unchanged sets; a floor absent from the set is cleared, leaving any
   * still-running pulse to expire on its own.
   */
  syncLaneFloors(lane: PresenceLane, kind: PresenceKind, identities: readonly BadgeIdentity[]): void {
    this.apply(reconcileLaneFloors(this.state, lane, kind, identities));
  }

  /**
   * Record a doc-scoped agent READ as a presence-lane `recent` badge whose fade
   * covers only the REMAINING read window (`occurredAtMs + readTtl - now`). A
   * read already older than the TTL is dropped, and a re-derived occurrence
   * within the repeat tolerance does not restart the fade.
   */
  recordAgentRead(identity: BadgeIdentity, occurredAtMs: number): void {
    this.recordRecentOccurrence(identity, occurredAtMs, AGENT_READ_RECENT_TTL_MS);
  }

  /**
   * Record a write (commit, or a human's final editor detach) against this doc
   * as a SEPARATE write-lane `recent` badge for the actor (may duplicate the
   * same identity's presence badge). Identities MUST carry `lane: "write"`.
   * The fade deadline is the ABSOLUTE `occurredAtMs + writeTtl`, so evidence
   * hydrated from an age shows only its remaining window and evidence already
   * older than the TTL is dropped.
   */
  recordWriteEvidence(identity: BadgeIdentity, occurredAtMs: number): void {
    this.recordRecentOccurrence(identity, occurredAtMs, recentTtlMsFor("write", identity.kind));
  }

  /**
   * Shared occurrence-based `recent` path: restart the fade only for evidence
   * strictly newer (beyond the repeat tolerance) than the last applied for this
   * (id, lane), and only for its remaining window.
   */
  private recordRecentOccurrence(
    identity: BadgeIdentity,
    occurredAtMs: number,
    ttlMs: number,
  ): void {
    const remainingMs = occurredAtMs + ttlMs - this.env.now();
    if (remainingMs <= 0) return; // outside the window — nothing to show
    const key = `${identity.lane} ${identity.id}`;
    const prev = this.lastEvidenceToken.get(key);
    if (prev !== undefined && occurredAtMs <= prev + REPEATED_EVIDENCE_TOLERANCE_MS) return;
    this.lastEvidenceToken.set(key, occurredAtMs);
    this.recent(identity, remainingMs);
  }

  // ---- scheduling ----------------------------------------------------------

  private apply(next: PresenceInternalState): void {
    this.state = next;
    this.reschedule();
    this.emitIfChanged();
  }

  /**
   * Recompute from stored deadlines: expire everything already due at `now`
   * (covering time that elapsed while the tab was throttled/backgrounded), then
   * rearm for whatever remains.
   */
  private recomputeFromDeadlines(): void {
    this.state = expireDue(this.state, this.env.now());
    this.reschedule();
    this.emitIfChanged();
  }

  private reschedule(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
    const nextMs = nextExpiryMs(this.state);
    if (nextMs === null) return;
    const delay = Math.max(0, nextMs - this.env.now()) + EXPIRY_EPSILON_MS;
    this.cancelTimer = this.env.schedule(() => {
      this.cancelTimer = null;
      this.state = expireDue(this.state, this.env.now());
      this.reschedule();
      this.emitIfChanged();
    }, delay);
  }

  private emitIfChanged(): void {
    const next = toSnapshot(this.state);
    const serialized = serializeSnapshot(next);
    if (serialized === this.lastSerialized) return;
    this.lastSerialized = serialized;
    this.lastSnapshot = next;
    this.listener?.(next);
  }
}
