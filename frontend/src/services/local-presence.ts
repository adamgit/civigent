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

  /** Mark which section this client is currently viewing/editing (broadcast to peers). */
  setViewingSection(fragmentKey: string): void {
    const user = this.awareness.getLocalState()?.user;
    this.awareness.setLocalStateField("user", { ...user, viewingSections: [fragmentKey] });
  }
}
