/**
 * DocSessionPublishPause — the per-DocSession publish-pause finite state machine
 * (spec 10 §DocSession publish pause; spec 05 §Proposal Publication).
 *
 * Because there is at most one active proposal per DocSession, publishing cannot
 * create a successor proposal and keep accepting edits. Instead the actor enters
 * a publish pause: every active editor socket is frozen, the backend waits for an
 * ordered `doc_publish_ready` ack from each socket that was active when the pause
 * started, and only then does final materialization + commit proceed.
 *
 * This module owns the PAUSE STATE ONLY (active-socket set, per-socket readiness,
 * timeout/abort). It does not own:
 *   - the wire frames `doc_publish_pause_start` / `doc_publish_ready` /
 *     `doc_publish_pause_end` (Area H defines/broadcasts those),
 *   - the actual commit (CRDTProposalGenerator.finalizeAndPublish),
 *   - the actor command serialization (the DocSession actor lane).
 *
 * The pause is per-DocSession, never global.
 *
 * Ordering proof (spec 10 step 6): because each `doc_publish_ready` ack arrives
 * on the SAME ordered editor socket as that socket's earlier Yjs updates, the
 * actor processing the ack proves those earlier updates have already reached the
 * actor. Callers must therefore feed ready acks through the actor's command lane,
 * in the same order the socket delivered them, before calling `markReady`.
 */

export type PublishPauseState = "idle" | "pausing" | "ready" | "aborted";

export interface PublishPauseResult {
  /** "ready" — all required sockets acked; safe to final-materialize + commit. */
  /** "aborted" — a required socket disconnected or readiness timed out. */
  outcome: "ready" | "aborted";
  reason?: "timeout" | "socket-disconnected" | "no-active-editors";
}

export interface PublishPauseOptions {
  /** Readiness collection timeout. On expiry the pause aborts (spec 10 step 7). */
  readinessTimeoutMs?: number;
}

export class DocSessionPublishPause {
  private state: PublishPauseState = "idle";

  /** Editor sockets that were active when the pause started (the required set). */
  private requiredSockets = new Set<string>();
  /** Sockets that have acknowledged readiness via an ordered `doc_publish_ready`. */
  private readySockets = new Set<string>();

  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveWaiter: ((result: PublishPauseResult) => void) | null = null;
  private settled = false;

  private readonly readinessTimeoutMs: number;

  constructor(opts: PublishPauseOptions = {}) {
    this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 10_000;
  }

  getState(): PublishPauseState {
    return this.state;
  }

  isActive(): boolean {
    return this.state === "pausing" || this.state === "ready";
  }

  /**
   * Start the publish pause for the given active editor socket set (spec 10
   * steps 2–4). Returns a promise that resolves when every required socket has
   * acked readiness (`ready`) or the pause aborts (`aborted`).
   *
   * If there are no active editor sockets, the frontier is trivially settled —
   * resolves `ready` immediately (e.g. last-editor-left publish). The caller is
   * responsible for sending `doc_publish_pause_start` on the wire (Area H).
   */
  start(activeEditorSocketIds: Iterable<string>): Promise<PublishPauseResult> {
    if (this.state !== "idle") {
      throw new Error(`DocSessionPublishPause.start called in state "${this.state}"; expected "idle".`);
    }
    this.requiredSockets = new Set(activeEditorSocketIds);
    this.readySockets = new Set();
    this.settled = false;
    this.state = "pausing";

    return new Promise<PublishPauseResult>((resolve) => {
      this.resolveWaiter = resolve;

      // No active editors: trivially settled (spec 10 — observer-only sockets do
      // not count as editors; last-editor-left has an empty required set).
      if (this.requiredSockets.size === 0) {
        this.settle({ outcome: "ready", reason: "no-active-editors" }, "ready");
        return;
      }

      this.timeoutTimer = setTimeout(() => {
        this.settle({ outcome: "aborted", reason: "timeout" }, "aborted");
      }, this.readinessTimeoutMs);
    });
  }

  /**
   * Feed an ordered `doc_publish_ready` ack from an editor socket (spec 10 steps
   * 5–6). Sockets not in the required set are ignored (they connected after the
   * pause started and started frozen; their readiness is implicit). When every
   * required socket is ready, the pause transitions to `ready`.
   */
  markReady(socketId: string): void {
    if (this.state !== "pausing") return;
    if (!this.requiredSockets.has(socketId)) return;
    this.readySockets.add(socketId);
    if (this.allRequiredReady()) {
      this.settle({ outcome: "ready" }, "ready");
    }
  }

  /**
   * Handle an editor socket disconnecting during the pause (spec 10 step 7).
   * If a REQUIRED socket disconnects before acking, the publish attempt aborts —
   * the backend must not optimistically publish while an unacknowledged editor
   * might have unsent or in-flight Yjs changes.
   */
  handleSocketDisconnect(socketId: string): void {
    if (this.state !== "pausing") return;
    if (!this.requiredSockets.has(socketId)) return;
    if (this.readySockets.has(socketId)) {
      // Already acked — its updates have reached the actor; a later disconnect
      // does not invalidate readiness.
      return;
    }
    this.settle({ outcome: "aborted", reason: "socket-disconnected" }, "aborted");
  }

  /** Explicitly abort an in-progress pause (e.g. forced operation gave up). */
  abort(): void {
    if (this.state !== "pausing") return;
    this.settle({ outcome: "aborted", reason: "socket-disconnected" }, "aborted");
  }

  /**
   * End the pause and return to idle so the next publish attempt can start
   * cleanly (spec 10 step 11 `doc_publish_pause_end`). The caller sends the wire
   * frame; this only resets the FSM. Safe to call from any state.
   */
  end(): void {
    this.clearTimer();
    this.requiredSockets = new Set();
    this.readySockets = new Set();
    this.resolveWaiter = null;
    this.settled = false;
    this.state = "idle";
  }

  /** Sockets still required to ack before the frontier is proven settled. */
  pendingSockets(): string[] {
    return [...this.requiredSockets].filter((id) => !this.readySockets.has(id));
  }

  private allRequiredReady(): boolean {
    for (const id of this.requiredSockets) {
      if (!this.readySockets.has(id)) return false;
    }
    return true;
  }

  private settle(result: PublishPauseResult, nextState: "ready" | "aborted"): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    this.state = nextState;
    const resolve = this.resolveWaiter;
    this.resolveWaiter = null;
    if (resolve) resolve(result);
  }

  private clearTimer(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }
}
