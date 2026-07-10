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
import {
  BrowserFragmentReplicaStore,
  type CrdtConnectionState,
} from "../../../services/browser-fragment-replica-store.js";
import { resolveTransportStatus } from "../../../services/section-save-state.js";

const FRAG_A = "section::alpha";
const FRAG_B = "section::beta";

/**
 * Named-field wrapper over the positional `resolveTransportStatus` signature so
 * the assertions read as honest scenarios. `localPending` = YOUR pending edits;
 * `inbound` = someone else's pending edits exist and none are yours; `hadLocal`
 * = sticky "you committed local work this session".
 */
function status(opts: {
  connection?: CrdtConnectionState;
  publishPaused?: boolean;
  isEditing?: boolean;
  allReceived?: boolean;
  localPending?: boolean;
  inbound?: boolean;
  hadLocal?: boolean;
  backendError?: string | null;
}): string {
  return resolveTransportStatus(
    opts.connection ?? "connected",
    opts.publishPaused ?? false,
    opts.isEditing ?? true,
    opts.allReceived ?? true,
    opts.localPending ?? false,
    opts.inbound ?? false,
    opts.hadLocal ?? false,
    opts.backendError ?? null,
  );
}

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
      expect(status({ isEditing: false })).toBe("idle");
      expect(status({ isEditing: false, publishPaused: true, connection: "disconnected" })).toBe("idle");
    });

    it("connected + clean with no local edits this session = idle (show nothing)", () => {
      expect(status({})).toBe("idle");
    });

    it("connected + clean after a real local save = saved", () => {
      expect(status({ hadLocal: true })).toBe("saved");
    });

    it("connecting / reconnecting surface their own status", () => {
      expect(status({ connection: "connecting" })).toBe("connecting");
      expect(status({ connection: "reconnecting" })).toBe("reconnecting");
    });

    it("error / disconnected while editing = offline", () => {
      expect(status({ connection: "error" })).toBe("offline");
      expect(status({ connection: "disconnected" })).toBe("offline");
    });

    it("offline outranks publication pause", () => {
      expect(status({ connection: "disconnected", publishPaused: true })).toBe("offline");
    });

    it("publish pause carrying YOUR edits = saving; not yours = updating", () => {
      expect(status({ publishPaused: true, localPending: true })).toBe("saving");
      expect(status({ publishPaused: true, allReceived: false })).toBe("saving");
      expect(status({ publishPaused: true, inbound: true })).toBe("updating");
      expect(status({ publishPaused: true })).toBe("updating");
    });

    // (a) Inbound publish-pause with no local edits must never read as your save.
    it("inbound publish-pause with no local edits → updating then upToDate (never savedToProposal/saved)", () => {
      // Pause running, stranded/other work committing, nothing of yours.
      const duringPause = status({ publishPaused: true, inbound: true });
      expect(duringPause).toBe("updating");
      expect(duringPause).not.toBe("saving");

      // Pause ended, inbound pending still present, still no local edits.
      const afterPause = status({ inbound: true });
      expect(afterPause).toBe("upToDate");
      expect(afterPause).not.toBe("savedToProposal");
      expect(afterPause).not.toBe("saved");
    });

    // (b) A real local edit still walks the full local ladder.
    it("a real local edit walks syncing → savedToProposal → saving → saved", () => {
      // In flight to the server.
      expect(status({ allReceived: false })).toBe("syncing");
      // Received, but the inprogress proposal still holds your edits.
      expect(status({ localPending: true })).toBe("savedToProposal");
      // The autonomous commit runs for your edits.
      expect(status({ publishPaused: true, localPending: true })).toBe("saving");
      // Committed and clean — sticky flag keeps it on "saved", not "idle".
      expect(status({ hadLocal: true })).toBe("saved");
    });

    // A server-signalled durable failure must not be hidden by the "looks fine"
    // rungs — pending / saved / up-to-date. Transport-level problems still win
    // because reconnecting first is what unblocks the round trip.
    it("backend error surfaces as `error` and does not collapse into pending/saved/up-to-date", () => {
      expect(status({ backendError: "normalize failed" })).toBe("error");
      expect(status({ backendError: "publish failed", localPending: true })).toBe("error");
      expect(status({ backendError: "materialize failed", hadLocal: true })).toBe("error");
      expect(status({ backendError: "validate failed", inbound: true })).toBe("error");
      // Publish pause does not mask the error either.
      expect(status({ backendError: "commit failed", publishPaused: true })).toBe("error");
      // Transport-level failures still dominate (reconnect first, then diagnose).
      expect(status({ backendError: "x", connection: "disconnected" })).toBe("offline");
      expect(status({ backendError: "x", connection: "reconnecting" })).toBe("reconnecting");
    });

    // Session-authored edits landing in the proposal are DURABLE (survive refresh
    // as replayed `section:pending`) — they are not an "unsaved" warning state.
    // The label must name that fact, not read as "Received — not yet saved".
    it("savedToProposal (Guarantee B) labels the proposal-durable rung, not an unsaved warning", () => {
      // Local pending with clean receipt watermark = proposal-saved but not
      // published. NOT `syncing` (in flight) and NOT `saved` (canonical).
      const s = status({ localPending: true });
      expect(s).toBe("savedToProposal");
      expect(s).not.toBe("syncing");
      expect(s).not.toBe("saved");
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
