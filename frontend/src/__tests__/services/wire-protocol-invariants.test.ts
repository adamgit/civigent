/**
 * Group A12: Frontend Wire Protocol Invariant Tests
 *
 * Invariant tests for the binary message decoding in CrdtProvider.
 * These verify that encoded server messages are correctly decoded and dispatched
 * to the appropriate event callbacks with the expected payload shape.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { CrdtProvider } from "../../services/crdt-provider";
import type { DocumentReplacementNoticePayload } from "../../types/shared";

// Protocol constants (must match crdt-provider.ts / crdt-ws-frames.ts)
const MSG_SYNC_STEP_2 = 0x01;
const MSG_REMOVED_STRUCTURE_WILL_CHANGE = 8; // permanently reserved-removed
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0b;
const MSG_DOC_PUBLISH_PAUSE_START = 0x10;
const MSG_DOC_PUBLISH_READY = 0x11;
const MSG_DOC_PUBLISH_PAUSE_END = 0x12;

// ─── StubWebSocket ──────────────────────────────────────────────
// Minimal WebSocket stub so CrdtProvider's `new WebSocket(url)` works.

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

beforeEach(() => {
  StubWebSocket.lastInstance = null;
  globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => "test-uuid-wire-proto",
    } as Crypto;
  }
});

afterEach(() => {
  StubWebSocket.lastInstance = null;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
});

// ─── Encode helpers (mirroring backend crdt-ws-frames.ts) ─────────

function encodeRemovedStructureWillChange(): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify([
    { oldKey: "frag:overview.md", newKeys: ["frag:overview.md", "frag:goals.md"] },
  ]));
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = MSG_REMOVED_STRUCTURE_WILL_CHANGE;
  buf.set(payload, 1);
  return buf;
}

function encodeDocumentReplacementNotice(payload: DocumentReplacementNoticePayload): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = MSG_DOCUMENT_REPLACEMENT_NOTICE;
  msg.set(json, 1);
  return msg;
}

function buildSyncStep2FromDoc(sourceDoc: Y.Doc): Uint8Array {
  const update = Y.encodeStateAsUpdate(sourceDoc);
  const msg = new Uint8Array(1 + update.length);
  msg[0] = MSG_SYNC_STEP_2;
  msg.set(update, 1);
  return msg;
}

/** Connect a CrdtProvider and return the opened stub WebSocket. */
function connectProvider(provider: CrdtProvider): StubWebSocket {
  provider.connect();
  const ws = StubWebSocket.lastInstance!;
  ws.open();
  return ws;
}

describe("A12: Frontend Wire Protocol Invariants", () => {
  // ── A12.1 ─────────────────────────────────────────────────────────

  it("A12.1: DOC_PUBLISH_PAUSE_START/END dispatch the pause callbacks and ack ready once", () => {
    const events: string[] = [];
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
      onPublishPauseStart: () => events.push("start"),
      onPublishPauseEnd: () => events.push("end"),
    });

    const ws = connectProvider(provider);
    ws.sentMessages.length = 0;

    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
    expect(events).toEqual(["start"]);
    // With no editor barrier the client is trivially quiescent → ready sent once.
    const ready = ws.sentMessages.filter((m) => m[0] === MSG_DOC_PUBLISH_READY);
    expect(ready.length).toBe(1);
    expect(provider.isPublishPaused).toBe(true);

    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]));
    expect(events).toEqual(["start", "end"]);
    expect(provider.isPublishPaused).toBe(false);

    // A pause_end without a prior pause_start is a no-op guard.
    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]));
    expect(events).toEqual(["start", "end"]);

    provider.destroy();
  });

  // ── A12.2 ─────────────────────────────────────────────────────────

  it("A12.2: removed STRUCTURE_WILL_CHANGE messages do not dispatch frontend callbacks", () => {
    const errors: string[] = [];
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
      onError: (reason) => errors.push(reason),
    });

    const ws = connectProvider(provider);

    ws.receiveServerMessage(encodeRemovedStructureWillChange());

    expect(errors).toEqual([]);
    expect(provider.state).toBe("connected");

    provider.destroy();
  });

  // ── A12.3 ─────────────────────────────────────────────────────────

  it("A12.3: DOCUMENT_REPLACEMENT_NOTICE message is sent after reconnect with correct payload", () => {
    const receivedPayloads: DocumentReplacementNoticePayload[] = [];
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
      onSynced: () => {},
      onDocumentReplacementNotice: (payload) => {
        receivedPayloads.push(payload);
      },
    });

    const ws = connectProvider(provider);

    const restorePayload: DocumentReplacementNoticePayload = {
      message: "document was restored to an earlier version",
    };

    // DOCUMENT_REPLACEMENT_NOTICE is buffered until SYNC_STEP_2 arrives
    ws.receiveServerMessage(encodeDocumentReplacementNotice(restorePayload));
    expect(receivedPayloads).toHaveLength(0); // Not delivered yet

    // Deliver SYNC_STEP_2 — triggers pending notice delivery
    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].message).toBe("document was restored to an earlier version");

    const secondPayload: DocumentReplacementNoticePayload = {
      message: "admin overwrote this document",
    };

    // Need a fresh connection for the second test since synced is already true
    // and pendingDocumentReplacementNotice was consumed. Simulate by sending another
    // notice — on an already-synced provider, SYNC_STEP_2 won't re-trigger
    // onSynced, but it will consume pendingDocumentReplacementNotice.
    ws.receiveServerMessage(encodeDocumentReplacementNotice(secondPayload));
    ws.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[1].message).toBe("admin overwrote this document");

    provider.destroy();
  });
});
