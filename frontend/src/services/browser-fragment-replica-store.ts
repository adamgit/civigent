/**
 * BrowserFragmentReplicaStore — per-document React-free state container.
 *
 * Holds:
 *   - the Y.Doc and Awareness instances (imperative binding targets for
 *     Milkdown and y-protocols — exposed as readonly fields)
 *   - connection state, synced flag, error string
 *   - per-fragment persistence state (clean / dirty / received / deleting)
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
 * Per-section persistence lifecycle:
 *   clean → dirty → received → clean
 *
 * "dirty"    — local edit, NOT yet confirmed received by server
 * "received" — server ACKd receipt (data in server RAM)
 * "clean"    — committed to canonical (absent from map)
 * "deleting" — terminal holding state for sections removed from Y.Doc
 */
export type SectionPersistenceState = "clean" | "dirty" | "received" | "deleting";

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
  readonly sectionPersistence: ReadonlyMap<string, SectionPersistenceState>;
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
  private _sectionPersistence: Map<string, SectionPersistenceState> = new Map();
  private _dirtySince: Map<string, number> = new Map();
  private _version = 0;

  private _snapshot: ReplicaSnapshot;
  private _sectionPersistenceView: ReadonlyMap<string, SectionPersistenceState>;

  constructor(doc: Y.Doc, awareness: Awareness) {
    this.doc = doc;
    this.awareness = awareness;
    this._sectionPersistenceView = this._sectionPersistence;
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

  /**
   * Returns the full section persistence map as a readonly view. The
   * reference is stable — it is replaced only when the underlying map
   * is actually mutated, which is what keeps useSyncExternalStore
   * selectors from firing spurious re-renders.
   */
  getSectionPersistence = (): ReadonlyMap<string, SectionPersistenceState> =>
    this._sectionPersistenceView;

  /**
   * Direct per-key lookup for render paths that only care about a single
   * section. Much cheaper than subscribing to the whole map when rendering
   * dozens of sections.
   */
  getSectionPersistenceForKey = (fragmentKey: string): SectionPersistenceState =>
    this._sectionPersistence.get(fragmentKey) ?? "clean";

  /**
   * Returns the timestamp (ms) when a fragment first entered the "dirty" state.
   * Undefined if the fragment is not currently dirty.
   */
  getDirtySince = (fragmentKey: string): number | undefined =>
    this._dirtySince.get(fragmentKey);

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
   * Move sections into the `"dirty"` state — called when a local Y.Doc
   * update is produced. Sections currently in `"received"` are dropped
   * back to `"dirty"` because the user edited them again.
   */
  markSectionsEdited(fragmentKeys: Iterable<string>): void {
    if (this.destroyed) return;
    let changed = false;
    const now = Date.now();
    for (const key of fragmentKeys) {
      if (this._sectionPersistence.get(key) !== "dirty") {
        this._sectionPersistence.set(key, "dirty");
        if (!this._dirtySince.has(key)) this._dirtySince.set(key, now);
        changed = true;
      }
    }
    if (changed) this.bumpSectionMap();
  }

  /**
   * Mark sections as `"received"` — server ACKd receipt of a MSG_YJS_UPDATE.
   * Data is now in server RAM (not yet on disk). Only transitions `"dirty"`
   * → `"received"`. Keys already in a later state are left alone.
   */
  markSectionsReceived(fragmentKeys: Iterable<string>): void {
    if (this.destroyed) return;
    let changed = false;
    for (const key of fragmentKeys) {
      if (this._sectionPersistence.get(key) === "dirty") {
        this._sectionPersistence.set(key, "received");
        changed = true;
      }
    }
    if (changed) this.bumpSectionMap();
  }

  /**
   * Drop sections back to `"clean"` — called when `content:committed`
   * arrives for these sections (they are now durable in canonical, so
   * the lifecycle wraps around). Only cleans sections in `"received"`
   * state. Sections that are `"dirty"` have new edits the commit
   * didn't include — those must NOT be cleared.
   */
  markSectionsClean(fragmentKeys: Iterable<string>): void {
    if (this.destroyed) return;
    let changed = false;
    for (const key of fragmentKeys) {
      const current = this._sectionPersistence.get(key);
      if (current === "received") {
        this._sectionPersistence.delete(key);
        this._dirtySince.delete(key);
        changed = true;
      }
    }
    if (changed) this.bumpSectionMap();
  }

  /**
   * Unconditionally remove sections from the persistence map regardless
   * of current state. Used for `deletedKeys` reported by the server
   * (sections that no longer exist in the document structure).
   */
  forceCleanSections(fragmentKeys: Iterable<string>): void {
    if (this.destroyed) return;
    let changed = false;
    for (const key of fragmentKeys) {
      if (this._sectionPersistence.has(key)) {
        this._sectionPersistence.delete(key);
        this._dirtySince.delete(key);
        changed = true;
      }
    }
    if (changed) this.bumpSectionMap();
  }

  markSectionsDeleting(fragmentKeys: Iterable<string>): void {
    if (this.destroyed) return;
    let changed = false;
    for (const key of fragmentKeys) {
      if (this._sectionPersistence.get(key) !== "deleting") {
        this._sectionPersistence.set(key, "deleting");
        changed = true;
      }
    }
    if (changed) this.bumpSectionMap();
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
    // `snapshot.sectionPersistence === prev.sectionPersistence` tracks
    // actual mutation. The internal map is reused in place for cost
    // reasons — external code only ever sees the readonly view.
    this._sectionPersistenceView = new Map(this._sectionPersistence);
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
      sectionPersistence: this._sectionPersistenceView,
      version: this._version,
    };
  }
}
