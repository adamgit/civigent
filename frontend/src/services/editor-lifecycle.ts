/**
 * EditorLifecycleController — explicit state machine for Milkdown editor lifecycle.
 *
 * States:
 *   unmounted → creating → created → awaiting_sync → attaching → ready
 *                                                                  ↓
 *                                              destroyed ← destroying
 *
 * No React dependency. Consumed by MilkdownEditor.tsx effects.
 */

import type { Crepe } from "@milkdown/crepe";
import type { Plugin } from "@milkdown/prose/state";

// ─── Types ──────────────────────────────────────────────

export type EditorState =
  | "unmounted"
  | "creating"
  | "created"
  | "awaiting_sync"
  | "attaching"
  | "ready"
  | "destroying"
  | "destroyed";

export type EditorEvent =
  | "start_create"
  | "crepe_created"
  | "crdt_provider_set"
  | "crdt_provider_removed"
  | "crdt_synced"
  | "attach_done"
  | "unmount";

// ─── Transition table ───────────────────────────────────

type TransitionEntry = { target: EditorState } | "noop" | "throw";

const TRANSITIONS: Record<EditorState, Partial<Record<EditorEvent, TransitionEntry>>> = {
  unmounted: {
    start_create: { target: "creating" },
  },
  creating: {
    crepe_created: { target: "created" },
    unmount: { target: "destroying" },
  },
  created: {
    crdt_provider_set: { target: "awaiting_sync" },
    // No CRDT needed — go straight to ready
    unmount: { target: "destroying" },
  },
  awaiting_sync: {
    crdt_synced: { target: "attaching" },
    crdt_provider_removed: { target: "created" },
    unmount: { target: "destroying" },
  },
  attaching: {
    attach_done: { target: "ready" },
    unmount: { target: "destroying" },
  },
  ready: {
    crdt_provider_removed: { target: "created" },
    unmount: { target: "destroying" },
  },
  destroying: {},
  destroyed: {},
};

// ─── Controller ─────────────────────────────────────────

export class EditorLifecycleController {
  private _state: EditorState = "unmounted";
  private _crepe: Crepe | null = null;
  private _basePlugins: Plugin[] = [];
  private _crdtAttached = false;
  private readonly _label: string;

  constructor(label: string) {
    this._label = label;
  }

  get state(): EditorState {
    return this._state;
  }

  get crepe(): Crepe | null {
    return this._crepe;
  }

  get basePlugins(): Plugin[] {
    return this._basePlugins;
  }

  get crdtAttached(): boolean {
    return this._crdtAttached;
  }

  /** Set the Crepe instance (called between start_create and crepe_created). */
  setCrepe(crepe: Crepe): void {
    this._crepe = crepe;
  }

  /** Store the base ProseMirror plugins before CRDT attachment. */
  setBasePlugins(plugins: Plugin[]): void {
    this._basePlugins = plugins;
  }

  setCrdtAttached(attached: boolean): void {
    this._crdtAttached = attached;
  }

  /** Returns Crepe only when the controller is in an "alive" state. */
  getCrepe(): Crepe | null {
    if (this._state === "destroying" || this._state === "destroyed" || this._state === "unmounted") {
      return null;
    }
    return this._crepe;
  }

  isReady(): boolean {
    return this._state === "ready";
  }

  /** Advance the state machine. Returns the new state. */
  send(event: EditorEvent): EditorState {
    const prev = this._state;

    // Events sent to destroying/destroyed are silent no-ops
    if (prev === "destroying" || prev === "destroyed") {
      console.debug(`[editor-lifecycle:${this._label}] ${prev} — ignoring ${event}`);
      return prev;
    }

    const entry = TRANSITIONS[prev]?.[event];

    if (!entry) {
      throw new Error(
        `[editor-lifecycle:${this._label}] Invalid event "${event}" in state "${prev}"`,
      );
    }

    if (entry === "noop") {
      return prev;
    }

    if (entry === "throw") {
      throw new Error(
        `[editor-lifecycle:${this._label}] Forbidden event "${event}" in state "${prev}"`,
      );
    }

    this._state = entry.target;
    console.debug(
      `[editor-lifecycle:${this._label}] ${prev} → ${this._state} (${event})`,
    );

    // Cleanup on destruction
    if (this._state === "destroying") {
      this._crdtAttached = false;
      this._basePlugins = [];
      this._state = "destroyed";
      console.debug(
        `[editor-lifecycle:${this._label}] destroying → destroyed (synchronous)`,
      );
    }

    return this._state;
  }
}
