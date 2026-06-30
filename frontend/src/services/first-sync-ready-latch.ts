/**
 * FirstSyncReadyLatch — one-shot gate that fires an editor's "ready" callback
 * only once its bound CRDT fragment has rendered content into the editor.
 *
 * y-prosemirror's `ySyncPlugin` populates a freshly-attached editor on a
 * DEFERRED dispatch, so marking the editor ready synchronously at attach time
 * exposes an empty editor for one frame — the static→live swap drops an empty
 * paragraph into flow before ySync fills it (the click-to-edit height jump).
 * This latch lets the editor defer readiness until the first ySync content
 * transaction is observed, with a fallback for a genuinely-empty fragment that
 * emits no such transaction.
 *
 * Transport/React-agnostic and fires `onReady` AT MOST ONCE.
 */

/** Minimal shape of a ProseMirror transaction we read meta off of. */
export interface PmTransactionLike {
  getMeta(key: unknown): unknown;
}

export class FirstSyncReadyLatch {
  private fired = false;
  private cancelled = false;

  constructor(private readonly onReady: () => void) {}

  /**
   * Feed a ProseMirror transaction batch (from a plugin's `appendTransaction`).
   * Fires `onReady` once when the first transaction carrying y-prosemirror's
   * `ySyncPluginKey` meta — the initial Yjs→ProseMirror render — is seen.
   */
  noteTransactions(trs: readonly PmTransactionLike[], ySyncKey: unknown): void {
    if (this.fired || this.cancelled) return;
    for (const tr of trs) {
      if (tr.getMeta(ySyncKey) !== undefined) {
        this.fire();
        return;
      }
    }
  }

  /** Fallback path: no ySync content transaction arrived (empty fragment). */
  fallback(): void {
    this.fire();
  }

  /** Abandon the latch (detach / unmount during the await window). */
  cancel(): void {
    this.cancelled = true;
  }

  get hasFired(): boolean {
    return this.fired;
  }

  private fire(): void {
    if (this.fired || this.cancelled) return;
    this.fired = true;
    this.onReady();
  }
}
