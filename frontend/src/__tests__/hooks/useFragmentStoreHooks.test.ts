/**
 * Hook-level tests for the BrowserFragmentReplicaStore subscription hooks.
 *
 * Covers the Area N additions: usePublishPaused + useSectionEditability
 * (null-tolerant useSyncExternalStore wrappers over the new store getters).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BrowserFragmentReplicaStore } from "../../services/browser-fragment-replica-store.js";
import {
  usePublishPaused,
  useSectionEditability,
} from "../../hooks/useFragmentStoreHooks.js";

const FRAG_A = "section::alpha";

describe("useFragmentStoreHooks (Area N)", () => {
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

  describe("usePublishPaused", () => {
    it("returns false for a null store", () => {
      const { result } = renderHook(() => usePublishPaused(null));
      expect(result.current).toBe(false);
    });

    it("tracks the store publication-pause flag", () => {
      const { result } = renderHook(() => usePublishPaused(store));
      expect(result.current).toBe(false);

      act(() => { store.setPublishPaused(true); });
      expect(result.current).toBe(true);

      act(() => { store.setPublishPaused(false); });
      expect(result.current).toBe(false);
    });
  });

  describe("useSectionEditability", () => {
    it("defaults to editable for a null store or unknown key", () => {
      const { result: r1 } = renderHook(() => useSectionEditability(null, FRAG_A));
      expect(r1.current).toBe("editable");

      const { result: r2 } = renderHook(() => useSectionEditability(store, FRAG_A));
      expect(r2.current).toBe("editable");
    });

    it("tracks blocked → unblocked → gone transitions for its key", () => {
      const { result } = renderHook(() => useSectionEditability(store, FRAG_A));

      act(() => { store.setSectionBlocked(FRAG_A); });
      expect(result.current).toBe("blocked");

      act(() => { store.setSectionUnblocked(FRAG_A); });
      expect(result.current).toBe("editable");

      act(() => { store.setSectionGone(FRAG_A); });
      expect(result.current).toBe("gone");
    });

    it("ignores transitions on other keys", () => {
      const { result } = renderHook(() => useSectionEditability(store, FRAG_A));
      act(() => { store.setSectionBlocked("section::other"); });
      expect(result.current).toBe("editable");
    });
  });
});
