/**
 * Unit tests for BrowserFragmentReplicaStore.
 *
 * The legacy per-section persistence lifecycle (clean/dirty/received/deleting)
 * is removed (spec 05 §"Content Flush"). Coverage now targets the replacement
 * state: connection/synced/error, the document-level publication-pause flag,
 * and the per-section editability map (editable/blocked/gone).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BrowserFragmentReplicaStore } from "../../services/browser-fragment-replica-store.js";

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

  // ─── Referential stability: connection state ────────────────────

  describe("connection-state snapshot stability", () => {
    it("returns same value on repeated reads with no mutation between them", () => {
      expect(store.getConnectionState()).toBe(store.getConnectionState());
    });

    it("snapshot reference unchanged when setConnectionState is called with the same value", () => {
      const snap1 = store.getSnapshot();
      store.setConnectionState("disconnected"); // same as initial
      expect(store.getSnapshot()).toBe(snap1);
    });

    it("snapshot reference changes when setConnectionState is called with a new value", () => {
      const snap1 = store.getSnapshot();
      store.setConnectionState("connecting");
      const snap2 = store.getSnapshot();
      expect(snap1).not.toBe(snap2);
      expect(snap2.connectionState).toBe("connecting");
    });
  });

  // ─── Publication-pause flag ─────────────────────────────────────

  describe("publication-pause flag", () => {
    it("defaults to false", () => {
      expect(store.getPublishPaused()).toBe(false);
      expect(store.getSnapshot().publishPaused).toBe(false);
    });

    it("setPublishPaused(true)/false flips the flag and bumps the snapshot", () => {
      const snap0 = store.getSnapshot();
      store.setPublishPaused(true);
      const snap1 = store.getSnapshot();
      expect(snap1).not.toBe(snap0);
      expect(store.getPublishPaused()).toBe(true);
      expect(snap1.publishPaused).toBe(true);

      store.setPublishPaused(false);
      expect(store.getPublishPaused()).toBe(false);
    });

    it("setting the same value is a no-op (stable snapshot)", () => {
      const snap = store.getSnapshot();
      store.setPublishPaused(false); // already false
      expect(store.getSnapshot()).toBe(snap);
    });
  });

  // ─── Per-section editability map ────────────────────────────────

  describe("per-section editability", () => {
    it("defaults unknown keys to editable", () => {
      expect(store.getSectionEditabilityForKey(FRAG_A)).toBe("editable");
      expect(store.getSectionEditability().size).toBe(0);
    });

    it("setSectionBlocked / setSectionUnblocked / setSectionGone transition state", () => {
      store.setSectionBlocked(FRAG_A);
      expect(store.getSectionEditabilityForKey(FRAG_A)).toBe("blocked");

      store.setSectionGone(FRAG_B);
      expect(store.getSectionEditabilityForKey(FRAG_B)).toBe("gone");

      store.setSectionUnblocked(FRAG_A);
      expect(store.getSectionEditabilityForKey(FRAG_A)).toBe("editable");
      // unblocked → editable drops the key so the map stays sparse
      expect(store.getSectionEditability().has(FRAG_A)).toBe(false);
    });

    it("returns same map reference when editability unchanged", () => {
      const first = store.getSectionEditability();
      expect(store.getSectionEditability()).toBe(first);
    });

    it("returns a new map reference after a mutation", () => {
      const before = store.getSectionEditability();
      store.setSectionBlocked(FRAG_A);
      expect(store.getSectionEditability()).not.toBe(before);
    });

    it("no-op transition (already in target state) does not change the reference", () => {
      store.setSectionBlocked(FRAG_A);
      const before = store.getSectionEditability();
      store.setSectionBlocked(FRAG_A); // already blocked
      expect(store.getSectionEditability()).toBe(before);
    });
  });

  // ─── Post-destroy snapshot access ───────────────────────────────

  describe("post-destroy behavior", () => {
    it("getSnapshot returns last-known snapshot after destroy", () => {
      store.setConnectionState("connected");
      store.setSynced(true);
      store.setSectionBlocked(FRAG_A);

      const lastSnap = store.getSnapshot();
      store.destroy();

      const postDestroy = store.getSnapshot();
      expect(postDestroy).toBe(lastSnap);
      expect(postDestroy.connectionState).toBe("connected");
      expect(postDestroy.synced).toBe(true);
      expect(postDestroy.sectionEditability.get(FRAG_A)).toBe("blocked");
    });

    it("mutations after destroy are no-ops", () => {
      store.setConnectionState("connected");
      const snapBefore = store.getSnapshot();
      store.destroy();

      store.setConnectionState("error");
      store.setSectionBlocked(FRAG_B);
      store.setPublishPaused(true);

      const snapAfter = store.getSnapshot();
      expect(snapAfter).toBe(snapBefore);
      expect(snapAfter.connectionState).toBe("connected");
    });

    it("subscribe after destroy returns a no-op unsubscribe (no throw)", () => {
      store.destroy();
      const callback = vi.fn();
      const unsub = store.subscribe(callback);
      expect(typeof unsub).toBe("function");
      store.setConnectionState("error");
      expect(callback).not.toHaveBeenCalled();
      unsub();
    });
  });

  // ─── subscribe / getSnapshot contract ───────────────────────────

  describe("subscribe(callback) / getSnapshot() contract", () => {
    it("callback fires on every state mutation", () => {
      const callback = vi.fn();
      store.subscribe(callback);

      store.setConnectionState("connecting");
      expect(callback).toHaveBeenCalledTimes(1);

      store.setSynced(true);
      expect(callback).toHaveBeenCalledTimes(2);

      store.setError("oops");
      expect(callback).toHaveBeenCalledTimes(3);

      store.setPublishPaused(true);
      expect(callback).toHaveBeenCalledTimes(4);

      store.setSectionBlocked(FRAG_A);
      expect(callback).toHaveBeenCalledTimes(5);
    });

    it("callback does NOT fire on no-op mutations", () => {
      const callback = vi.fn();
      store.subscribe(callback);

      store.setConnectionState("disconnected"); // same as initial
      store.setSynced(false); // same as initial
      store.setError(null); // same as initial
      store.setPublishPaused(false); // already false
      store.setSectionUnblocked(FRAG_A); // already editable

      expect(callback).not.toHaveBeenCalled();
    });

    it("unsubscribe stops future notifications", () => {
      const callback = vi.fn();
      const unsub = store.subscribe(callback);

      store.setConnectionState("connecting");
      expect(callback).toHaveBeenCalledTimes(1);

      unsub();
      store.setConnectionState("connected");
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("version increments on each mutation", () => {
      const v0 = store.getSnapshot().version;
      store.setConnectionState("connecting");
      const v1 = store.getSnapshot().version;
      store.setSectionBlocked(FRAG_C);
      const v2 = store.getSnapshot().version;

      expect(v1).toBe(v0 + 1);
      expect(v2).toBe(v1 + 1);
    });
  });
});
