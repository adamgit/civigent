/**
 * Unit tests for CrdtTransport wiring onto BrowserFragmentReplicaStore.
 *
 * Covers:
 *   B17.1 — Transport calls store mutation methods on receiving WebSocket messages
 *   B17.3 — SESSION_OVERLAY_IMPORTED -> store.markSectionsSaved(...)
 *   B17.4 — STRUCTURE_WILL_CHANGE -> appropriate store restructuring mutation
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { CrdtTransport } from "../../services/crdt-transport.js";
import { BrowserFragmentReplicaStore } from "../../services/browser-fragment-replica-store.js";

// Protocol message types (must match crdt-provider.ts)
const MSG_SYNC_STEP_1 = 0x00;
const MSG_SYNC_STEP_2 = 0x01;
const MSG_SESSION_OVERLAY_IMPORTED = 4;
const MSG_STRUCTURE_WILL_CHANGE = 8;

// ─── StubWebSocket ──────────────────────────────────────────────
// Same pattern as crdt-provider-restore.test.ts — replaces globalThis.WebSocket.

class StubWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  readyState: number = StubWebSocket.CONNECTING;

  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;

  sentMessages: Uint8Array[] = [];
  closeCallCount = 0;

  static lastInstance: StubWebSocket | null = null;

  constructor(url: string | URL) {
    super();
    this.url = typeof url === "string" ? url : url.toString();
    StubWebSocket.lastInstance = this;
  }

  send(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === "string") return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.sentMessages.push(new Uint8Array(bytes));
  }

  close(): void {
    this.closeCallCount++;
    this.readyState = StubWebSocket.CLOSED;
  }

  receiveServerMessage(bytes: Uint8Array): void {
    if (this.onmessage) {
      this.onmessage(
        new MessageEvent("message", {
          data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        }),
      );
    }
  }

  open(): void {
    this.readyState = StubWebSocket.OPEN;
    if (this.onopen) this.onopen(new Event("open"));
  }
}

const originalWebSocket = globalThis.WebSocket;

function buildSyncStep2(doc?: Y.Doc): Uint8Array {
  const d = doc ?? new Y.Doc();
  const state = Y.encodeStateAsUpdate(d);
  const msg = new Uint8Array(1 + state.length);
  msg[0] = MSG_SYNC_STEP_2;
  msg.set(state, 1);
  if (!doc) d.destroy();
  return msg;
}

function buildOverlayImportedMessage(writtenKeys: string[], deletedKeys: string[]): Uint8Array {
  const text = writtenKeys.join("\n") + "\x00" + deletedKeys.join("\n");
  const encoded = new TextEncoder().encode(text);
  const msg = new Uint8Array(1 + encoded.length);
  msg[0] = MSG_SESSION_OVERLAY_IMPORTED;
  msg.set(encoded, 1);
  return msg;
}

function buildStructureWillChangeMessage(
  restructures: Array<{ oldKey: string; newKeys: string[] }>,
): Uint8Array {
  const json = JSON.stringify(restructures);
  const encoded = new TextEncoder().encode(json);
  const msg = new Uint8Array(1 + encoded.length);
  msg[0] = MSG_STRUCTURE_WILL_CHANGE;
  msg.set(encoded, 1);
  return msg;
}

beforeEach(() => {
  StubWebSocket.lastInstance = null;
  // Stub crypto.randomUUID if not available (test environments).
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as any).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => "00000000-0000-0000-0000-000000000000",
    };
  }
  globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  StubWebSocket.lastInstance = null;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe("CrdtTransport", () => {
  let transport: CrdtTransport;
  let store: BrowserFragmentReplicaStore;

  function connectAndSync(): StubWebSocket {
    transport.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();
    // Complete sync: send SYNC_STEP_2 so the provider enters synced state.
    ws.receiveServerMessage(buildSyncStep2());
    return ws;
  }

  beforeEach(() => {
    transport = new CrdtTransport("/test/doc.md");
    store = new BrowserFragmentReplicaStore(transport.doc, transport.awareness);
    transport.attachStore(store);
  });

  afterEach(() => {
    transport.destroy();
  });

  // ─── B17.1 ── Transport calls store mutation methods on WS messages ─

  describe("B17.1 — Transport calls store mutation methods on receiving WebSocket messages", () => {
    it("onStateChange routes to store.setConnectionState", () => {
      transport.connect();
      // After connect(), the provider calls setState("connecting") which fires onStateChange.
      expect(store.getConnectionState()).toBe("connecting");

      const ws = StubWebSocket.lastInstance!;
      ws.open();
      // onopen → setState("connected")
      expect(store.getConnectionState()).toBe("connected");
    });

    it("onSynced routes to store.setSynced(true)", () => {
      expect(store.getSynced()).toBe(false);

      const ws = connectAndSync();

      expect(store.getSynced()).toBe(true);
    });

    it("onError routes to store.setError", () => {
      transport.connect();
      const ws = StubWebSocket.lastInstance!;
      // Simulate close with non-recoverable error code.
      ws.readyState = StubWebSocket.CLOSED;
      if (ws.onclose) {
        ws.onclose(new CloseEvent("close", { code: 4010, reason: "Invalid URL" }));
      }

      expect(store.getError()).toBe("Invalid URL");
    });

    it("one-way dependency: store never calls back into transport", () => {
      // The store has no reference to the transport — verify by checking
      // that the store constructor signature is (doc, awareness) only.
      const testDoc = new Y.Doc();
      const testAwareness = new Awareness(testDoc);
      const isolatedStore = new BrowserFragmentReplicaStore(testDoc, testAwareness);

      // No transport-related methods on the store.
      expect((isolatedStore as any).transport).toBeUndefined();
      expect((isolatedStore as any).provider).toBeUndefined();

      testAwareness.destroy();
      testDoc.destroy();
    });
  });

  // ─── B17.3 ── SESSION_OVERLAY_IMPORTED → forceCleanSections ────

  describe("B17.3 — SESSION_OVERLAY_IMPORTED → store.forceCleanSections(deletedKeys)", () => {
    it("deleted keys are force-cleaned (removed from persistence map)", () => {
      const ws = connectAndSync();

      store.markSectionsEdited(["section::gamma"]);
      expect(store.getSectionPersistenceForKey("section::gamma")).toBe("dirty");

      ws.receiveServerMessage(
        buildOverlayImportedMessage([], ["section::gamma"]),
      );

      expect(store.getSectionPersistenceForKey("section::gamma")).toBe("clean");
      expect(store.getSectionPersistence().has("section::gamma")).toBe(false);
    });

    it("written keys in the payload do not mutate store state", () => {
      const ws = connectAndSync();

      store.markSectionsEdited(["section::alpha"]);
      store.markSectionsReceived(["section::alpha"]);
      expect(store.getSectionPersistenceForKey("section::alpha")).toBe("received");

      ws.receiveServerMessage(
        buildOverlayImportedMessage(["section::alpha"], []),
      );

      // writtenKeys are no longer routed to any store mutation
      expect(store.getSectionPersistenceForKey("section::alpha")).toBe("received");
    });
  });

  // ─── B17.4 ── STRUCTURE_WILL_CHANGE → store restructuring ──────

  describe("B17.4 — STRUCTURE_WILL_CHANGE → appropriate store restructuring mutation", () => {
    it("fires the opts.onStructureWillChange callback with parsed restructures", () => {
      const callback = vi.fn();
      // Create a transport with the onStructureWillChange option.
      const transport2 = new CrdtTransport("/test/doc2.md", {
        onStructureWillChange: callback,
      });
      const store2 = new BrowserFragmentReplicaStore(transport2.doc, transport2.awareness);
      transport2.attachStore(store2);
      transport2.connect();

      const ws = StubWebSocket.lastInstance!;
      ws.open();
      ws.receiveServerMessage(buildSyncStep2());

      const restructures = [
        { oldKey: "section::alpha", newKeys: ["section::alpha-1", "section::alpha-2"] },
      ];

      ws.receiveServerMessage(buildStructureWillChangeMessage(restructures));

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(restructures);

      transport2.destroy();
    });

    it("store persistence state is NOT mutated by STRUCTURE_WILL_CHANGE (store does not model restructures)", () => {
      const ws = connectAndSync();

      store.markSectionsEdited(["section::alpha"]);
      const snapBefore = store.getSnapshot();
      const persistenceBefore = store.getSectionPersistence();

      ws.receiveServerMessage(
        buildStructureWillChangeMessage([
          { oldKey: "section::alpha", newKeys: ["section::alpha-new"] },
        ]),
      );

      // Store should be unaffected — STRUCTURE_WILL_CHANGE is passthrough only.
      const persistenceAfter = store.getSectionPersistence();
      expect(persistenceAfter.get("section::alpha")).toBe("dirty");
      // The "new" key should NOT appear in the map (transport doesn't route this to store).
      expect(persistenceAfter.has("section::alpha-new")).toBe(false);
    });
  });
});
