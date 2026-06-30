/**
 * FirstSyncReadyLatch (spec 05 §Editing UX; click-to-edit height-jump fix).
 *
 * Guards the readiness ordering: the editor must NOT be marked ready (onReady)
 * until the first ySync content transaction has rendered the fragment — and a
 * genuinely-empty fragment that emits no such transaction must still become ready
 * via the fallback. The latch is one-shot.
 */

import { describe, it, expect, vi } from "vitest";
import { FirstSyncReadyLatch, type PmTransactionLike } from "../../services/first-sync-ready-latch";

const Y_SYNC_KEY = { sync: true }; // stand-in for y-prosemirror's ySyncPluginKey

function tx(meta: Map<unknown, unknown>): PmTransactionLike {
  return { getMeta: (key) => meta.get(key) };
}
function syncTx(): PmTransactionLike {
  return tx(new Map<unknown, unknown>([[Y_SYNC_KEY, { isChangeOrigin: true }]]));
}
function plainTx(): PmTransactionLike {
  return tx(new Map());
}

describe("FirstSyncReadyLatch", () => {
  it("does NOT fire on construction", () => {
    const onReady = vi.fn();
    const latch = new FirstSyncReadyLatch(onReady);
    expect(onReady).not.toHaveBeenCalled();
    expect(latch.hasFired).toBe(false);
  });

  it("does NOT fire for transaction batches lacking the ySync meta", () => {
    const onReady = vi.fn();
    const latch = new FirstSyncReadyLatch(onReady);
    latch.noteTransactions([plainTx(), plainTx()], Y_SYNC_KEY);
    expect(onReady).not.toHaveBeenCalled();
    expect(latch.hasFired).toBe(false);
  });

  it("fires once when the first ySync content transaction is seen", () => {
    const onReady = vi.fn();
    const latch = new FirstSyncReadyLatch(onReady);
    latch.noteTransactions([plainTx(), syncTx()], Y_SYNC_KEY);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(latch.hasFired).toBe(true);
  });

  it("is idempotent across further sync transactions and the fallback", () => {
    const onReady = vi.fn();
    const latch = new FirstSyncReadyLatch(onReady);
    latch.noteTransactions([syncTx()], Y_SYNC_KEY);
    latch.noteTransactions([syncTx()], Y_SYNC_KEY);
    latch.fallback();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("fallback fires for an empty fragment that emits no sync transaction", () => {
    const onReady = vi.fn();
    const latch = new FirstSyncReadyLatch(onReady);
    latch.fallback();
    expect(onReady).toHaveBeenCalledTimes(1);
    // A sync transaction arriving later (e.g. late content) does not re-fire.
    latch.noteTransactions([syncTx()], Y_SYNC_KEY);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("cancel() prevents any firing (detach / unmount during the await window)", () => {
    const onReady = vi.fn();
    const latch = new FirstSyncReadyLatch(onReady);
    latch.cancel();
    latch.noteTransactions([syncTx()], Y_SYNC_KEY);
    latch.fallback();
    expect(onReady).not.toHaveBeenCalled();
    expect(latch.hasFired).toBe(false);
  });
});
