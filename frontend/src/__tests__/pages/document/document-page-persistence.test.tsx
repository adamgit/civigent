/**
 * Transport/publish-status + block-state integration tests.
 *
 * The legacy per-section receipt save-state machine (clean/dirty/received/
 * deleting + resolveSaveState/worstSaveState) is removed (spec 05 §"Content
 * Flush" / §"Section-Level Persistence Status Indicators"). These tests now
 * exercise the replacement: the coarse transport/publish status derivation and
 * the per-section editability map the DocumentPage drives.
 *
 * No rendered DOM — tests the state directly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BrowserFragmentReplicaStore } from "../../../services/browser-fragment-replica-store.js";
import { resolveTransportStatus } from "../../../services/section-save-state.js";

const FRAG_A = "section::alpha";
const FRAG_B = "section::beta";

describe("DocumentPage transport/publish status", () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let store: BrowserFragmentReplicaStore;

  beforeEach(() => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    store = new BrowserFragmentReplicaStore(doc, awareness);
    store.setConnectionState("connected");
  });

  afterEach(() => {
    awareness.destroy();
    doc.destroy();
  });

  describe("resolveTransportStatus", () => {
    it("read-only viewers (not editing) see nothing", () => {
      expect(resolveTransportStatus("connected", false, false)).toBe("idle");
      expect(resolveTransportStatus("disconnected", true, false)).toBe("idle");
    });

    it("connected + synced while editing = synced", () => {
      expect(resolveTransportStatus("connected", false, true)).toBe("synced");
    });

    it("publication pause wins over a healthy connection", () => {
      expect(resolveTransportStatus("connected", true, true)).toBe("publishing");
    });

    it("connecting / reconnecting surface their own status", () => {
      expect(resolveTransportStatus("connecting", false, true)).toBe("connecting");
      expect(resolveTransportStatus("reconnecting", false, true)).toBe("reconnecting");
    });

    it("error / disconnected while editing = offline", () => {
      expect(resolveTransportStatus("error", false, true)).toBe("offline");
      expect(resolveTransportStatus("disconnected", false, true)).toBe("offline");
    });

    it("offline outranks publication pause", () => {
      expect(resolveTransportStatus("disconnected", true, true)).toBe("offline");
    });
  });

  describe("publication pause flag", () => {
    it("drives the store-level publishPaused flag", () => {
      expect(store.getPublishPaused()).toBe(false);
      store.setPublishPaused(true);
      expect(store.getPublishPaused()).toBe(true);
      store.setPublishPaused(false);
      expect(store.getPublishPaused()).toBe(false);
    });
  });

  describe("per-section block-state", () => {
    it("blocked → read-only (editability 'blocked')", () => {
      store.setSectionBlocked(FRAG_A);
      expect(store.getSectionEditabilityForKey(FRAG_A)).toBe("blocked");
      expect(store.getSectionEditabilityForKey(FRAG_B)).toBe("editable");
    });

    it("gone → unmounted (editability 'gone')", () => {
      store.setSectionGone(FRAG_A);
      expect(store.getSectionEditabilityForKey(FRAG_A)).toBe("gone");
    });

    it("unblocked returns to editable", () => {
      store.setSectionBlocked(FRAG_A);
      store.setSectionUnblocked(FRAG_A);
      expect(store.getSectionEditabilityForKey(FRAG_A)).toBe("editable");
    });
  });
});
