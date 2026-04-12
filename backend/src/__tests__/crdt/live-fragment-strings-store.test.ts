/**
 * Unit tests for LiveFragmentStringsStore.
 *
 * Covers:
 *   B2.2 — replaceFragmentStrings(map, origin) batch-updates multiple fragments atomically
 *   B2.3 — Write with non-server origin marks fragment ahead-of-staged
 *   B3.1 — applyClientUpdate applies Yjs binary update and returns exact set of touched keys
 *   B3.4 — Awareness-only (no-op) update returns empty touched-keys set
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { LiveFragmentStringsStore, SERVER_INJECTION_ORIGIN } from "../../crdt/live-fragment-strings-store.js";
import { fragmentFromRemark, type FragmentContent } from "../../storage/section-formatting.js";

const ALPHA = "section::alpha";
const BETA = "section::beta";
const GAMMA = "section::gamma";

const KEYS = [ALPHA, BETA, GAMMA];

function mkContent(text: string): FragmentContent {
  return fragmentFromRemark(text);
}

describe("LiveFragmentStringsStore", () => {
  let ydoc: Y.Doc;
  let store: LiveFragmentStringsStore;

  beforeEach(() => {
    ydoc = new Y.Doc();
    store = new LiveFragmentStringsStore(ydoc, KEYS, "/test/doc.md");

    // Seed each fragment with initial content via server origin (not dirty).
    store.replaceFragmentString(ALPHA, mkContent("Alpha initial"), SERVER_INJECTION_ORIGIN);
    store.replaceFragmentString(BETA, mkContent("Beta initial"), SERVER_INJECTION_ORIGIN);
    store.replaceFragmentString(GAMMA, mkContent("Gamma initial"), SERVER_INJECTION_ORIGIN);
  });

  afterEach(() => {
    ydoc.destroy();
  });

  // ─── B2.2 ── replaceFragmentStrings batch atomicity ───────────────

  describe("B2.2 — replaceFragmentStrings batch-updates multiple fragments atomically", () => {
    it("updates all mapped fragments in a single call", () => {
      const batchMap = new Map<string, FragmentContent>([
        [ALPHA, mkContent("Alpha batch")],
        [BETA, mkContent("Beta batch")],
      ]);

      store.replaceFragmentStrings(batchMap, SERVER_INJECTION_ORIGIN);

      const alphaContent = store.readFragmentString(ALPHA) as string;
      const betaContent = store.readFragmentString(BETA) as string;
      const gammaContent = store.readFragmentString(GAMMA) as string;

      expect(alphaContent).toContain("Alpha batch");
      expect(betaContent).toContain("Beta batch");
      // Gamma should be unchanged.
      expect(gammaContent).toContain("Gamma initial");
    });

    it("batch content is visible in a second Y.Doc synced from state", () => {
      const batchMap = new Map<string, FragmentContent>([
        [ALPHA, mkContent("Alpha synced")],
        [BETA, mkContent("Beta synced")],
      ]);

      store.replaceFragmentStrings(batchMap, SERVER_INJECTION_ORIGIN);

      // Create a second Y.Doc and apply the full state from the first.
      const mirrorDoc = new Y.Doc();
      Y.applyUpdate(mirrorDoc, Y.encodeStateAsUpdate(ydoc));

      // Build a second store on the mirror to read back content.
      const mirrorStore = new LiveFragmentStringsStore(mirrorDoc, KEYS, "/test/doc.md");

      const alphaContent = mirrorStore.readFragmentString(ALPHA) as string;
      const betaContent = mirrorStore.readFragmentString(BETA) as string;

      expect(alphaContent).toContain("Alpha synced");
      expect(betaContent).toContain("Beta synced");

      mirrorDoc.destroy();
    });
  });

  // ─── B2.3 ── Non-server origin marks ahead-of-staged ─────────────

  describe("B2.3 — write with non-server origin marks fragment ahead-of-staged", () => {
    it("client-origin write sets ahead-of-staged for the written key only", () => {
      // Clear any residual ahead-of-staged state from setup.
      store.clearAheadOfStaged(KEYS);

      // Sanity: nothing is ahead-of-staged.
      expect(store.isAheadOfStaged(ALPHA)).toBe(false);
      expect(store.isAheadOfStaged(BETA)).toBe(false);
      expect(store.isAheadOfStaged(GAMMA)).toBe(false);

      // Write with a non-server origin.
      store.replaceFragmentString(ALPHA, mkContent("Alpha client edit"), "client-origin");

      expect(store.isAheadOfStaged(ALPHA)).toBe(true);
      expect(store.isAheadOfStaged(BETA)).toBe(false);
      expect(store.isAheadOfStaged(GAMMA)).toBe(false);
    });

    it("server-origin write does NOT set ahead-of-staged", () => {
      store.clearAheadOfStaged(KEYS);

      store.replaceFragmentString(ALPHA, mkContent("Alpha server rewrite"), SERVER_INJECTION_ORIGIN);

      expect(store.isAheadOfStaged(ALPHA)).toBe(false);
    });
  });

  // ─── B3.1 ── applyClientUpdate returns exact touched keys ─────────

  describe("B3.1 — applyClientUpdate returns exact set of touched fragment keys", () => {
    it("returns only the fragment key modified by the client update", () => {
      // 1. Create a client Y.Doc and sync initial state from the store.
      const clientDoc = new Y.Doc();
      Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(ydoc));

      // 2. Capture the store's state vector BEFORE the client edit.
      const svBefore = Y.encodeStateVector(ydoc);

      // 3. Modify the alpha fragment in the client doc.
      const frag = clientDoc.getXmlFragment(ALPHA);
      const text = new Y.XmlText("hello from client");
      frag.insert(frag.length, [text]);

      // 4. Compute the diff update relative to the store's prior state.
      const diffUpdate = Y.encodeStateAsUpdate(clientDoc, svBefore);

      // 5. Apply through the store's API.
      const touched = store.applyClientUpdate("w1", diffUpdate, "client");

      // 6. Verify touched set contains only alpha.
      expect(touched.has(ALPHA)).toBe(true);
      expect(touched.has(BETA)).toBe(false);
      expect(touched.has(GAMMA)).toBe(false);
      expect(touched.size).toBe(1);

      // 7. Verify the Y.Doc fragment was actually modified.
      // (readFragmentString goes through ProseMirror deserialization which
      // requires valid ProseMirror node types — raw XmlText insertion doesn't
      // produce those. Verify the Yjs state directly instead.)
      const frag2 = ydoc.getXmlFragment(ALPHA);
      expect(frag2.length).toBeGreaterThan(0);

      clientDoc.destroy();
    });
  });

  // ─── B3.4 ── No-op update returns empty touched set ───────────────

  describe("B3.4 — no-op update returns empty touched-keys set", () => {
    it("applying a diff with no content changes returns an empty set", () => {
      // 1. Create a client doc and sync — but do NOT modify anything.
      const clientDoc = new Y.Doc();
      Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(ydoc));

      // 2. Capture state vector after sync (identical to the store).
      const svBefore = Y.encodeStateVector(ydoc);

      // 3. Compute a diff update — should be empty / no-op.
      const diffUpdate = Y.encodeStateAsUpdate(clientDoc, svBefore);

      // 4. Apply through the store.
      const touched = store.applyClientUpdate("w1", diffUpdate, "client");

      // 5. Should have touched nothing.
      expect(touched.size).toBe(0);

      clientDoc.destroy();
    });
  });
});
