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
 * The per-section block-state is the load-bearing editability authority
 * (spec 05-ydoc-lifecycle §"Section block-state events").
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

/**
 * A section with uncommitted edits in a DocSession's `inprogress` proposal
 * (Guarantee B), driven by the server `section:pending` / `section:settled`
 * events. `writerId` lets the UI distinguish "you are editing this" from
 * "edited by {writerDisplayName} — not yet saved".
 */
export interface PendingSection {
  readonly writerId: string;
  readonly writerDisplayName: string;
}

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
  /** Guarantee A (doc-level): true when every local edit has been acknowledged
   *  as received by the server (the receipt watermark has caught up). */
  readonly receiptAllReceived: boolean;
  /** Guarantee B: sections with uncommitted edits in the live inprogress
   *  proposal, keyed by fragment_key. */
  readonly pendingSections: ReadonlyMap<string, PendingSection>;
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
  private _receiptAllReceived = true;
  private _pendingSections: Map<string, PendingSection> = new Map();
  private _version = 0;

  private _snapshot: ReplicaSnapshot;
  private _sectionEditabilityView: ReadonlyMap<string, SectionEditability>;
  private _pendingSectionsView: ReadonlyMap<string, PendingSection>;

  constructor(doc: Y.Doc, awareness: Awareness) {
    this.doc = doc;
    this.awareness = awareness;
    this._sectionEditabilityView = this._sectionEditability;
    this._pendingSectionsView = this._pendingSections;
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

  /** Guarantee A: true when the receipt watermark has caught up to all local
   *  edits (nothing in flight to the server). */
  getReceiptAllReceived = (): boolean => this._receiptAllReceived;

  /** Guarantee B: the full pending-sections map (referentially stable view). */
  getPendingSections = (): ReadonlyMap<string, PendingSection> =>
    this._pendingSectionsView;

  /** Guarantee B: the pending entry for a single fragment, or null when it has
   *  no uncommitted edits. */
  getPendingSectionForKey = (fragmentKey: string): PendingSection | null =>
    this._pendingSections.get(fragmentKey) ?? null;

  // Whether ANY/which pending edits are "mine" is a presentation concern,
  // resolved against session authorship in `useDocSaveStatusInputs` by reading
  // the pending-sections map above — never here. The store is server truth only
  // and deliberately knows nothing about the current editor's session.

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

  /**
   * Guarantee A: update the receipt watermark — true once every local edit is
   * acknowledged received by the server. Driven by the binary `MSG_UPDATE_ACK`
   * frame via the transport.
   */
  setReceiptAllReceived(next: boolean): void {
    if (this.destroyed || this._receiptAllReceived === next) return;
    this._receiptAllReceived = next;
    this.bump();
  }

  /** Server `section:pending` — the section gained uncommitted edits. */
  setSectionPending(fragmentKey: string, writer: PendingSection): void {
    if (this.destroyed) return;
    const current = this._pendingSections.get(fragmentKey);
    if (current && current.writerId === writer.writerId
      && current.writerDisplayName === writer.writerDisplayName) return;
    this._pendingSections.set(fragmentKey, writer);
    this.bumpPendingSections();
  }

  /** Server `section:settled` — the section's uncommitted edits committed. */
  setSectionSettled(fragmentKey: string): void {
    if (this.destroyed || !this._pendingSections.has(fragmentKey)) return;
    this._pendingSections.delete(fragmentKey);
    this.bumpPendingSections();
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

  private bumpPendingSections(): void {
    // Fresh reference so `snapshot.pendingSections === prev.pendingSections`
    // tracks actual mutation (same pattern as the editability view).
    this._pendingSectionsView = new Map(this._pendingSections);
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
      receiptAllReceived: this._receiptAllReceived,
      pendingSections: this._pendingSectionsView,
      version: this._version,
    };
  }
}
