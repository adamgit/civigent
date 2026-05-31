/**
 * BrowserFragmentReplicaStore — per-document React-free state container.
 *
 * Holds:
 *   - the Y.Doc and Awareness instances (imperative binding targets for
 *     Milkdown and y-protocols — exposed as readonly fields)
 *   - connection state, synced flag, error string
 *   - a document-level publication-pause flag (DocSession publish pause)
 *   - a per-section editability map (`"editable" | "blocked" | "gone"`)
 *     driven by the server `section:blocked|unblocked|gone` events
 *
 * The legacy per-fragment persistence lifecycle (clean / dirty / received /
 * deleting) and the receipt/overlay machinery are removed — spec
 * 05-ydoc-lifecycle §"Content Flush" (removed) and §"Section-Level Persistence
 * Status Indicators" (the document-level SaveStatus machine is removed). The
 * per-section block-state is now the load-bearing editability authority
 * (§"Section block-state events").
 *
 * Integrates with React via `useSyncExternalStore(subscribe, getSnapshot)`.
 * Snapshot getters return referentially stable values: the same object
 * reference is returned until the underlying data actually changes. A
 * version counter is bumped on every mutation so subscribers re-render
 * only when something they care about moved.
 *
 * Has no React dependency of its own. Transport code (CrdtTransport) is
 * the only caller of the mutation methods — the store never calls back
 * into the transport (one-way dependency: transport → store).
 *
 * Safe to call after `destroy()`: the last-known snapshots remain
 * readable, and `subscribe()` accepts but never fires new notifications.
 * This keeps late-running React commits from throwing during unmount.
 */

import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

// Inlined from services/crdt-provider.ts to keep the store independent.
// Must stay in sync if the transport redefines these.
export type CrdtConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/**
 * Per-section editability state, kept in lockstep with server reality via the
 * `section:blocked|unblocked|gone` events:
 *
 *   "editable" — default; the section may be mounted and edited.
 *   "blocked"  — a proposal lock owns the section; mounted editors go read-only
 *                and the frontend stops attempting to mount it.
 *   "gone"     — the section's canonical identifier no longer resolves
 *                (rename/delete); it is unmounted and removed from the mount Set.
 */
export type SectionEditability = "editable" | "blocked" | "gone";

type Listener = () => void;

/**
 * Narrow immutable view of store state, consumed via useSyncExternalStore.
 * Returned by reference and swapped atomically on every mutation, so
 * equality checks in selectors work.
 */
export interface ReplicaSnapshot {
  readonly connectionState: CrdtConnectionState;
  readonly synced: boolean;
  readonly error: string | null;
  readonly publishPaused: boolean;
  readonly sectionEditability: ReadonlyMap<string, SectionEditability>;
  readonly version: number;
}

export class BrowserFragmentReplicaStore {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  private listeners = new Set<Listener>();
  private destroyed = false;

  private _connectionState: CrdtConnectionState = "disconnected";
  private _synced = false;
  private _error: string | null = null;
  private _publishPaused = false;
  private _sectionEditability: Map<string, SectionEditability> = new Map();
  private _version = 0;

  private _snapshot: ReplicaSnapshot;
  private _sectionEditabilityView: ReadonlyMap<string, SectionEditability>;

  constructor(doc: Y.Doc, awareness: Awareness) {
    this.doc = doc;
    this.awareness = awareness;
    this._sectionEditabilityView = this._sectionEditability;
    this._snapshot = this.buildSnapshot();
  }

  // ─── Subscription & snapshots ──────────────────────────────────

  subscribe = (listener: Listener): (() => void) => {
    if (this.destroyed) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReplicaSnapshot => this._snapshot;

  getConnectionState = (): CrdtConnectionState => this._connectionState;

  getSynced = (): boolean => this._synced;

  getError = (): string | null => this._error;

  getPublishPaused = (): boolean => this._publishPaused;

  /**
   * Returns the full section-editability map as a readonly view. The
   * reference is stable — it is replaced only when the underlying map is
   * actually mutated, which keeps useSyncExternalStore selectors from
   * firing spurious re-renders.
   */
  getSectionEditability = (): ReadonlyMap<string, SectionEditability> =>
    this._sectionEditabilityView;

  /**
   * Direct per-key lookup for render paths that only care about a single
   * section. Defaults to `"editable"` for any key the server has not
   * blocked / removed.
   */
  getSectionEditabilityForKey = (fragmentKey: string): SectionEditability =>
    this._sectionEditability.get(fragmentKey) ?? "editable";

  // ─── Mutations ─────────────────────────────────────────────────
  //
  // All mutation methods follow the same pattern: short-circuit when no
  // observable data has changed (keeps version stable → keeps snapshot
  // reference stable), otherwise mutate in place and call `bump()` to
  // replace the snapshot and notify listeners exactly once.

  setConnectionState(next: CrdtConnectionState): void {
    if (this.destroyed || this._connectionState === next) return;
    this._connectionState = next;
    this.bump();
  }

  setSynced(next: boolean): void {
    if (this.destroyed || this._synced === next) return;
    this._synced = next;
    this.bump();
  }

  setError(next: string | null): void {
    if (this.destroyed || this._error === next) return;
    this._error = next;
    this.bump();
  }

  /**
   * Document-level publication-pause flag. Set true on
   * `doc_publish_pause_start`, false on `doc_publish_pause_end`. While true,
   * every mounted (and newly-mounted) editor for this document is frozen.
   */
  setPublishPaused(next: boolean): void {
    if (this.destroyed || this._publishPaused === next) return;
    this._publishPaused = next;
    this.bump();
  }

  /** Server `section:blocked` — a proposal lock now owns the section. */
  setSectionBlocked(fragmentKey: string): void {
    this.setSectionEditability(fragmentKey, "blocked");
  }

  /** Server `section:unblocked` — the section returns to editable. */
  setSectionUnblocked(fragmentKey: string): void {
    this.setSectionEditability(fragmentKey, "editable");
  }

  /** Server `section:gone` — the section's canonical identifier no longer resolves. */
  setSectionGone(fragmentKey: string): void {
    this.setSectionEditability(fragmentKey, "gone");
  }

  private setSectionEditability(fragmentKey: string, next: SectionEditability): void {
    if (this.destroyed) return;
    const current = this._sectionEditability.get(fragmentKey) ?? "editable";
    if (current === next) return;
    if (next === "editable") {
      // The default — drop the key so the map stays sparse.
      this._sectionEditability.delete(fragmentKey);
    } else {
      this._sectionEditability.set(fragmentKey, next);
    }
    this.bumpSectionMap();
  }

  // ─── Teardown ──────────────────────────────────────────────────

  /**
   * Marks the store destroyed. Existing snapshots remain readable so
   * late-running React commits don't throw; new mutations are no-ops and
   * new subscriptions never fire. The caller is responsible for
   * destroying the `doc` and `awareness` — the store does NOT touch them
   * here because other parts of the session may still need access during
   * the same tick.
   */
  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────

  private bumpSectionMap(): void {
    // Replace the readonly view with a fresh reference so selector
    // `snapshot.sectionEditability === prev.sectionEditability` tracks
    // actual mutation. The internal map is reused in place for cost
    // reasons — external code only ever sees the readonly view.
    this._sectionEditabilityView = new Map(this._sectionEditability);
    this.bump();
  }

  private bump(): void {
    this._version += 1;
    this._snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): ReplicaSnapshot {
    return {
      connectionState: this._connectionState,
      synced: this._synced,
      error: this._error,
      publishPaused: this._publishPaused,
      sectionEditability: this._sectionEditabilityView,
      version: this._version,
    };
  }
}
