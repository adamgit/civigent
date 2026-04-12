/**
 * Persistence state-machine integration tests.
 *
 * Exercises the full chain: BrowserFragmentReplicaStore mutations →
 * resolveSaveState → worstSaveState, matching the real protocol
 * sequences the DocumentPage drives.
 *
 * No rendered DOM — tests the state machine directly, so label text
 * changes never break these.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BrowserFragmentReplicaStore } from "../../../services/browser-fragment-replica-store.js";
import { resolveSaveState, worstSaveState, type SectionSaveState } from "../../../services/section-save-state.js";

const FRAG_A = "section::alpha";
const FRAG_B = "section::beta";

function resolve(
  store: BrowserFragmentReplicaStore,
  key: string,
  nowMs = 1000,
): SectionSaveState {
  return resolveSaveState(
    store.getSectionPersistence().get(key),
    store.getConnectionState(),
    store.getDirtySince(key),
    nowMs,
  );
}

describe("DocumentPage persistence", () => {
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

  // ─── Happy path: full lifecycle ────────────────────────────────

  describe("full persistence lifecycle (happy path)", () => {
    it("clean → dirty → received → clean", () => {
      expect(resolve(store, FRAG_A)).toBe("saved");

      store.markSectionsEdited([FRAG_A]);
      expect(resolve(store, FRAG_A)).toBe("not_received");

      store.markSectionsReceived([FRAG_A]);
      expect(resolve(store, FRAG_A)).toBe("received_in_ram");

      store.markSectionsClean([FRAG_A]);
      expect(resolve(store, FRAG_A)).toBe("saved");
    });
  });

  // ─── Connection failure modes ──────────────────────────────────

  describe("connection failure while dirty", () => {
    it("dirty + disconnected = send_failed_no_retry", () => {
      store.markSectionsEdited([FRAG_A]);
      store.setConnectionState("disconnected");
      expect(resolve(store, FRAG_A)).toBe("send_failed_no_retry");
    });

    it("dirty + error = send_failed_no_retry", () => {
      store.markSectionsEdited([FRAG_A]);
      store.setConnectionState("error");
      expect(resolve(store, FRAG_A)).toBe("send_failed_no_retry");
    });

    it("dirty + reconnecting = send_failed_will_retry", () => {
      store.markSectionsEdited([FRAG_A]);
      store.setConnectionState("reconnecting");
      expect(resolve(store, FRAG_A)).toBe("send_failed_will_retry");
    });

    it("dirty + connecting = send_failed_will_retry", () => {
      store.markSectionsEdited([FRAG_A]);
      store.setConnectionState("connecting");
      expect(resolve(store, FRAG_A)).toBe("send_failed_will_retry");
    });
  });

  // ─── Receipt timeout ───────────────────────────────────────────

  describe("receipt timeout detection", () => {
    it("dirty section becomes receipt_timeout after 10s without server ACK", () => {
      store.markSectionsEdited([FRAG_A]);
      const dirtySince = store.getDirtySince(FRAG_A)!;

      expect(resolve(store, FRAG_A, dirtySince + 5_000)).toBe("not_received");
      expect(resolve(store, FRAG_A, dirtySince + 10_001)).toBe("receipt_timeout");
    });

    it("receipt clears the timeout — received state does not time out", () => {
      store.markSectionsEdited([FRAG_A]);
      const dirtySince = store.getDirtySince(FRAG_A)!;

      store.markSectionsReceived([FRAG_A]);
      expect(resolve(store, FRAG_A, dirtySince + 20_000)).toBe("received_in_ram");
    });
  });

  // ─── Aggregate (worst-of) ──────────────────────────────────────

  describe("worstSaveState aggregation", () => {
    it("empty list = saved", () => {
      expect(worstSaveState([])).toBe("saved");
    });

    it("worst-of picks the highest-risk state", () => {
      expect(worstSaveState(["saved", "received_in_ram"])).toBe("received_in_ram");
      expect(worstSaveState(["received_in_ram", "not_received"])).toBe("not_received");
      expect(worstSaveState(["not_received", "send_failed_no_retry"])).toBe("send_failed_no_retry");
    });

    it("receipt_timeout outranks not_received", () => {
      expect(worstSaveState(["not_received", "receipt_timeout"])).toBe("receipt_timeout");
    });
  });

  // ─── Deleting state ────────────────────────────────────────────

  describe("deleting state", () => {
    it("deleting sections resolve to deleting regardless of connection", () => {
      store.markSectionsDeleting([FRAG_A]);
      expect(resolve(store, FRAG_A)).toBe("deleting");

      store.setConnectionState("error");
      expect(resolve(store, FRAG_A)).toBe("deleting");
    });
  });
});
