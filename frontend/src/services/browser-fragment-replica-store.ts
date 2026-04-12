/**
 * BrowserFragmentReplicaStore — per-document React-free state container.
 *
 * Holds:
 *   - the Y.Doc and Awareness instances (imperative binding targets for
 *     Milkdown and y-protocols — exposed as readonly fields)
 *   - connection state, synced flag, error string
 *   - per-fragment persistence state (clean / dirty / pending / flushed / deleting)
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
 *   clean → dirty → pending → flushed → clean
 * "deleting" is a terminal holding state for sections removed from the
 * Y.Doc (used to keep a placeholder rendered until cleanup).
 */
export type SectionPersistenceState = "clean" | "dirty" | "pending" | "flushed" | "deleting";

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
   * update is produced. Sections currently in a later stage (pending /
   * flushed) are dropped back to `"dirty"` because the user edited them
   * again after the last flush.
   */
  markSectionsEdited(fragmentKeys: Iterable<string>): void {
    if (this.destroyed) return;
    let changed = false;
    for (const key of fragmentKeys) {
      if (this._sectionPersistence.get(key) !== "dirty") {
        this._sectionPersistence.set(key, "dirty");
        changed = true;
      }
    }
    if (changed) this.bumpSectionMap();
  }

  /**
   * Move dirty sections to `"pending"` — called when the client sends
   * a flush request (or learns the server has begun an overlay import
   * for these keys). Sections that are not currently `"dirty"` are left
   * alone: the state machine only allows dirty → pending.
   */
  promoteEditedToSaving(fragmentKeys: Iterable<string>): void {
    if (this.destroyed) return;
    let changed = false;
    for (const key of fragmentKeys) {
      if (this._sectionPersistence.get(key) === "dirty") {
        this._sectionPersistence.set(key, "pending");
        changed = true;
      }
    }
    if (changed) this.bumpSectionMap();
  }

  /**
   * Mark sections as `"flushed"` — called when the server acknowledges a
   * successful overlay import. Accepts any non-deleting prior state
   * because the server may know about keys that never passed through the
   * local pending state (e.g. multi-writer scenarios).
   */
  markSectionsSaved(fragmentKeys: Iterable<string>): void {
    if (this.destroyed) return;
    let changed = false;
    for (const key of fragmentKeys) {
      const current = this._sectionPersistence.get(key);
      if (current !== "flushed" && current !== "deleting") {
        this._sectionPersistence.set(key, "flushed");
        changed = true;
      }
    }
    if (changed) this.bumpSectionMap();
  }

  /**
   * Drop sections back to `"clean"` — called when `content:committed`
   * arrives for these sections (they are now durable in canonical, so
   * the lifecycle wraps around).
   */
  markSectionsClean(fragmentKeys: Iterable<string>): void {
    if (this.destroyed) return;
    let changed = false;
    for (const key of fragmentKeys) {
      if (this._sectionPersistence.has(key)) {
        this._sectionPersistence.delete(key);
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
