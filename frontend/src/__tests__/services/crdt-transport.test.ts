/**
 * Unit tests for CrdtTransport wiring onto BrowserFragmentReplicaStore.
 *
 * Covers:
 *   - Transport routes connection/sync/error onto store mutation methods
 *   - DocSession publish-pause frames route to store.setPublishPaused(...)
 *   - one-way dependency: store never references the transport/provider
 *
 * The legacy SESSION_OVERLAY_IMPORTED / STRUCTURE_WILL_CHANGE / receipt
 * plumbing is removed (spec 05 §4 > Removed message types). Section block-state
 * (`section:*`) rides the JSON application WebSocket, not this binary channel.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { CrdtTransport } from "../../services/crdt-transport.js";
import { BrowserFragmentReplicaStore } from "../../services/browser-fragment-replica-store.js";

// Protocol message types (must match crdt-provider.ts / crdt-ws-frames.ts)
const MSG_SYNC_STEP_2 = 0x01;
const MSG_DOC_PUBLISH_PAUSE_START = 0x10;
const MSG_DOC_PUBLISH_READY = 0x11;
const MSG_DOC_PUBLISH_PAUSE_END = 0x12;

// ─── StubWebSocket ──────────────────────────────────────────────

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

beforeEach(() => {
  StubWebSocket.lastInstance = null;
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

  describe("connection state routing", () => {
    it("onStateChange routes to store.setConnectionState", () => {
      transport.connect();
      expect(store.getConnectionState()).toBe("connecting");
      const ws = StubWebSocket.lastInstance!;
      ws.open();
      expect(store.getConnectionState()).toBe("connected");
    });

    it("onSynced routes to store.setSynced(true)", () => {
      expect(store.getSynced()).toBe(false);
      connectAndSync();
      expect(store.getSynced()).toBe(true);
    });

    it("onError routes to store.setError", () => {
      transport.connect();
      const ws = StubWebSocket.lastInstance!;
      ws.readyState = StubWebSocket.CLOSED;
      ws.onclose?.(new CloseEvent("close", { code: 4010, reason: "Invalid URL" }));
      expect(store.getError()).toBe("Invalid URL");
    });

    it("one-way dependency: store never references transport/provider", () => {
      const testDoc = new Y.Doc();
      const testAwareness = new Awareness(testDoc);
      const isolatedStore = new BrowserFragmentReplicaStore(testDoc, testAwareness);
      expect((isolatedStore as any).transport).toBeUndefined();
      expect((isolatedStore as any).provider).toBeUndefined();
      testAwareness.destroy();
      testDoc.destroy();
    });
  });

  describe("DocSession publish-pause routing", () => {
    it("doc_publish_pause_start sets store.publishPaused = true", () => {
      const ws = connectAndSync();
      expect(store.getPublishPaused()).toBe(false);
      ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
      expect(store.getPublishPaused()).toBe(true);
    });

    it("doc_publish_pause_end clears store.publishPaused", () => {
      const ws = connectAndSync();
      ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
      expect(store.getPublishPaused()).toBe(true);
      ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]));
      expect(store.getPublishPaused()).toBe(false);
    });

    it("invokes the onPublishPauseStart/End passthroughs", () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const t2 = new CrdtTransport("/test/doc2.md", {
        onPublishPauseStart: onStart,
        onPublishPauseEnd: onEnd,
      });
      const s2 = new BrowserFragmentReplicaStore(t2.doc, t2.awareness);
      t2.attachStore(s2);
      t2.connect();
      const ws = StubWebSocket.lastInstance!;
      ws.open();
      ws.receiveServerMessage(buildSyncStep2());
      ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
      ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]));
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
      t2.destroy();
    });

    it("sends doc_publish_ready exactly once after pause_start (no editor barrier)", () => {
      const ws = connectAndSync();
      ws.sentMessages.length = 0;
      ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
      const readyFrames = ws.sentMessages.filter((m) => m[0] === MSG_DOC_PUBLISH_READY);
      expect(readyFrames.length).toBe(1);
    });
  });
});
