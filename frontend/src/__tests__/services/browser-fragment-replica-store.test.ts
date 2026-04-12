/**
 * Unit tests for BrowserFragmentReplicaStore.
 *
 * Covers:
 *   B16.2 — getConnectionState returns stable reference when state unchanged
 *   B16.3 — getSectionPersistence returns same Map reference when persistence state unchanged
 *   B16.4 — markSectionsEdited(keys) transitions affected keys to edited state
 *   B16.7 — markSectionsClean(keys) removes committed sections from persistence state
 *   B16.8 — After destroy(), snapshot methods still return last-known values
 *   B16.9 — subscribe(callback) / getSnapshot() contract: callback fires on every state mutation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  BrowserFragmentReplicaStore,
  type ReplicaSnapshot,
} from "../../services/browser-fragment-replica-store.js";

const FRAG_A = "section::alpha";
const FRAG_B = "section::beta";
const FRAG_C = "section::gamma";

describe("BrowserFragmentReplicaStore", () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let store: BrowserFragmentReplicaStore;

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    store = new BrowserFragmentReplicaStore(doc, awareness);
  });

  afterEach(() => {
    awareness.destroy();
    doc.destroy();
  });

  // ─── B16.2 ── Referential stability: connection state ───────────

  describe("B16.2 — getConnectionState returns stable reference when state unchanged", () => {
    it("returns same value on repeated reads with no mutation between them", () => {
      const first = store.getConnectionState();
      const second = store.getConnectionState();
      expect(first).toBe(second);
    });

    it("snapshot reference unchanged when setConnectionState is called with the same value", () => {
      const snap1 = store.getSnapshot();
      store.setConnectionState("disconnected"); // same as initial
      const snap2 = store.getSnapshot();
      // Same reference — no mutation, no re-render.
      expect(snap1).toBe(snap2);
    });

    it("snapshot reference changes when setConnectionState is called with a new value", () => {
      const snap1 = store.getSnapshot();
      store.setConnectionState("connecting");
      const snap2 = store.getSnapshot();
      expect(snap1).not.toBe(snap2);
      expect(snap2.connectionState).toBe("connecting");
    });
  });

  // ─── B16.3 ── Referential stability: section persistence map ────

  describe("B16.3 — getSectionPersistence returns same Map reference when persistence state unchanged", () => {
    it("returns same Map reference on repeated reads with no mutation", () => {
      const first = store.getSectionPersistence();
      const second = store.getSectionPersistence();
      expect(first).toBe(second);
    });

    it("returns new Map reference after a section persistence mutation", () => {
      const before = store.getSectionPersistence();
      store.markSectionsEdited([FRAG_A]);
      const after = store.getSectionPersistence();
      expect(before).not.toBe(after);
    });

    it("no-op markSectionsEdited (already dirty) does not change Map reference", () => {
      store.markSectionsEdited([FRAG_A]);
      const before = store.getSectionPersistence();
      store.markSectionsEdited([FRAG_A]); // already dirty
      const after = store.getSectionPersistence();
      expect(before).toBe(after);
    });
  });

  // ─── B16.4 ── markSectionsEdited transitions to edited state ────

  describe("B16.4 markSectionsEdited(keys) transitions affected keys to edited state", () => {
    it("transitions clean keys to dirty", () => {
      store.markSectionsEdited([FRAG_A, FRAG_B]);
      expect(store.getSectionPersistenceForKey(FRAG_A)).toBe("dirty");
      expect(store.getSectionPersistenceForKey(FRAG_B)).toBe("dirty");
      // Unaffected key stays clean.
      expect(store.getSectionPersistenceForKey(FRAG_C)).toBe("clean");
    });

    it("drops received keys back to dirty on re-edit", () => {
      store.markSectionsEdited([FRAG_A]);
      store.markSectionsReceived([FRAG_A]); // dirty → received
      expect(store.getSectionPersistenceForKey(FRAG_A)).toBe("received");

      store.markSectionsEdited([FRAG_A]); // re-edit while received
      expect(store.getSectionPersistenceForKey(FRAG_A)).toBe("dirty");
    });
  });


  // ─── B16.7  markSectionsClean removes from persistence state ──

  describe("B16.7 — markSectionsClean(keys) removes committed sections from persistence state", () => {
    it("removes received keys from the persistence map", () => {
      store.markSectionsEdited([FRAG_A, FRAG_B]);
      store.markSectionsReceived([FRAG_A, FRAG_B]);
      expect(store.getSectionPersistence().size).toBe(2);

      store.markSectionsClean([FRAG_A, FRAG_B]);
      expect(store.getSectionPersistence().size).toBe(0);
      expect(store.getSectionPersistenceForKey(FRAG_A)).toBe("clean");
      expect(store.getSectionPersistenceForKey(FRAG_B)).toBe("clean");
    });

    it("does not clean dirty keys (user has new edits the commit didn't include)", () => {
      store.markSectionsEdited([FRAG_A]);
      store.markSectionsClean([FRAG_A]);
      expect(store.getSectionPersistenceForKey(FRAG_A)).toBe("dirty");
      expect(store.getSectionPersistence().has(FRAG_A)).toBe(true);
    });

    it("no-op when key is already clean (not in map)", () => {
      const before = store.getSectionPersistence();
      store.markSectionsClean([FRAG_A]); // never dirtied
      const after = store.getSectionPersistence();
      // No mutation → same reference.
      expect(before).toBe(after);
    });
  });

  // ─── B16.8 ── Post-destroy snapshot access ─────────────────────

  describe("B16.8 — After destroy(), snapshot methods still return last-known values", () => {
    it("getSnapshot returns last-known snapshot after destroy", () => {
      store.setConnectionState("connected");
      store.setSynced(true);
      store.markSectionsEdited([FRAG_A]);

      const lastSnap = store.getSnapshot();
      store.destroy();

      const postDestroy = store.getSnapshot();
      expect(postDestroy).toBe(lastSnap);
      expect(postDestroy.connectionState).toBe("connected");
      expect(postDestroy.synced).toBe(true);
      expect(postDestroy.sectionPersistence.get(FRAG_A)).toBe("dirty");
    });

    it("mutations after destroy are no-ops", () => {
      store.setConnectionState("connected");
      const snapBefore = store.getSnapshot();
      store.destroy();

      store.setConnectionState("error");
      store.markSectionsEdited([FRAG_B]);

      const snapAfter = store.getSnapshot();
      // Snapshot unchanged — mutations were no-ops.
      expect(snapAfter).toBe(snapBefore);
      expect(snapAfter.connectionState).toBe("connected");
    });

    it("subscribe after destroy returns a no-op unsubscribe (no throw)", () => {
      store.destroy();
      const callback = vi.fn();
      const unsub = store.subscribe(callback);
      expect(typeof unsub).toBe("function");
      // Mutation should not fire the late subscriber.
      store.setConnectionState("error");
      expect(callback).not.toHaveBeenCalled();
      // Unsub should not throw.
      unsub();
    });
  });

  // ─── B16.9 ── subscribe / getSnapshot contract ─────────────────

  describe("B16.9 — subscribe(callback) / getSnapshot() contract", () => {
    it("callback fires on every state mutation", () => {
      const callback = vi.fn();
      store.subscribe(callback);

      store.setConnectionState("connecting");
      expect(callback).toHaveBeenCalledTimes(1);

      store.setSynced(true);
      expect(callback).toHaveBeenCalledTimes(2);

      store.setError("oops");
      expect(callback).toHaveBeenCalledTimes(3);

      store.markSectionsEdited([FRAG_A]);
      expect(callback).toHaveBeenCalledTimes(4);
    });

    it("callback does NOT fire on no-op mutations", () => {
      const callback = vi.fn();
      store.subscribe(callback);

      store.setConnectionState("disconnected"); // same as initial
      store.setSynced(false); // same as initial
      store.setError(null); // same as initial
      store.markSectionsClean([FRAG_A]); // already clean

      expect(callback).not.toHaveBeenCalled();
    });

    it("getSnapshot returns new reference after mutation, same reference before", () => {
      const snap1 = store.getSnapshot();
      store.setConnectionState("connected");
      const snap2 = store.getSnapshot();

      expect(snap1).not.toBe(snap2);
      expect(snap2.connectionState).toBe("connected");

      // No mutation → same reference.
      const snap3 = store.getSnapshot();
      expect(snap2).toBe(snap3);
    });

    it("unsubscribe stops future notifications", () => {
      const callback = vi.fn();
      const unsub = store.subscribe(callback);

      store.setConnectionState("connecting");
      expect(callback).toHaveBeenCalledTimes(1);

      unsub();
      store.setConnectionState("connected");
      // No additional call.
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("version increments on each mutation", () => {
      const v0 = store.getSnapshot().version;
      store.setConnectionState("connecting");
      const v1 = store.getSnapshot().version;
      store.markSectionsEdited([FRAG_A]);
      const v2 = store.getSnapshot().version;

      expect(v1).toBe(v0 + 1);
      expect(v2).toBe(v1 + 1);
    });
  });
});
