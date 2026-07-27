/**
 * LocalPresence — owns the MEANING of this client's presence fields broadcast to
 * peers over the Yjs Awareness protocol.
 *
 * Awareness is the low-level MECHANISM (peer-state sync); it is created and owned
 * by `CrdtTransport` and exposed readonly as `transport.awareness`. The semantics
 * of presence — i.e. that a user's local state carries a `viewingSections` field —
 * are an application/collaboration concern that belongs here, not on the
 * connection facade (`CrdtTransport`). Consumers write presence through this
 * object and never touch `awareness.setLocalStateField` directly.
 */

import type { Awareness } from "y-protocols/awareness";

export class LocalPresence {
  constructor(private readonly awareness: Awareness) {}

  /**
   * P20 — broadcast that this client has the document OPEN, with no editor
   * attached. Establishes the named identity every viewer needs to appear in the
   * shared presence strip's `present` floor, independent of ever editing. Merges
   * so it never clobbers a richer editor-attached state (an already-set
   * `viewingSections`/cursor wins); a plain open tab carries `viewingSections: []`
   * so consumers can tell "here, not editing" (`present`) from "editing"
   * (`active`). Idempotent — safe to call once per live-session join.
   */
  setPageOpen(name: string, color: string): void {
    const user = this.awareness.getLocalState()?.user;
    this.awareness.setLocalStateField("user", {
      name,
      color,
      viewingSections: [],
      ...user,
    });
  }

  /** Mark which section this client is currently viewing/editing (broadcast to peers). */
  setViewingSection(fragmentKey: string): void {
    const user = this.awareness.getLocalState()?.user;
    this.awareness.setLocalStateField("user", { ...user, viewingSections: [fragmentKey] });
  }

  /**
   * Return to the page-open baseline: keep the named identity but clear the
   * editing marker so this client settles from `active` back to the `present`
   * floor when its editor detaches (rather than lingering as "editing").
   */
  clearViewingSection(): void {
    const user = this.awareness.getLocalState()?.user;
    if (!user) return;
    this.awareness.setLocalStateField("user", { ...user, viewingSections: [] });
  }
}
