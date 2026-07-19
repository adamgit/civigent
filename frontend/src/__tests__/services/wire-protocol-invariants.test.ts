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
import { LIVE_SECTION_SERVER_APPLY_ORIGIN } from "../../services/live-section-replica";
import type { DocumentReplacementNoticePayload } from "../../types/shared";

// Protocol constants (must match crdt-provider.ts / crdt-ws-frames.ts)
const MSG_REMOVED_STRUCTURE_WILL_CHANGE = 8; // permanently reserved-removed
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0b;
const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;
const MSG_DOC_PUBLISH_PAUSE_START = 0x10;
const MSG_DOC_PUBLISH_READY = 0x11;
const MSG_DOC_PUBLISH_PAUSE_END = 0x12;
const MSG_YJS_UPDATE = 0x02;

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

/** The sole join body fill — releases the buffered replacement notice. */
function buildLiveSectionsBootstrapFromDoc(sourceDoc: Y.Doc): Uint8Array {
  const update = Y.encodeStateAsUpdate(sourceDoc);
  const header = new TextEncoder().encode(JSON.stringify({
    doc_session_id: "sess-test",
    state: { topology: [], blocked_section_ids: [], pending_sections: [], publish_pause_join_mirror: "not_in_pause" },
  }));
  const msg = new Uint8Array(1 + 4 + header.length + update.length);
  msg[0] = MSG_LIVE_SECTIONS_BOOTSTRAP;
  msg[1] = (header.length >>> 24) & 0xff;
  msg[2] = (header.length >>> 16) & 0xff;
  msg[3] = (header.length >>> 8) & 0xff;
  msg[4] = header.length & 0xff;
  msg.set(header, 5);
  msg.set(update, 5 + header.length);
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

    // A pause_end without a prior pause_start still notifies (mid-pause joiner
    // recovery: a bootstrap-mirror-only freeze can only be cleared by this
    // callback) — but it never produces another doc_publish_ready ack.
    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]));
    expect(events).toEqual(["start", "end", "end"]);
    expect(ws.sentMessages.filter((m) => m[0] === MSG_DOC_PUBLISH_READY).length).toBe(1);

    provider.destroy();
  });

  // ── A12.2 ─────────────────────────────────────────────────────────

  it("A12.2: removed STRUCTURE_WILL_CHANGE messages fail loud", () => {
    const errors: string[] = [];
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
      onError: (reason) => errors.push(reason),
    });

    const ws = connectProvider(provider);

    ws.receiveServerMessage(encodeRemovedStructureWillChange());

    expect(errors.some((e) => e.includes("Unexpected CRDT opcode 0x8"))).toBe(true);
    expect(ws.closeCallCount).toBeGreaterThan(0);

    provider.destroy();
  });

  // ── A12.3 ─────────────────────────────────────────────────────────

  it("A12.3: DOCUMENT_REPLACEMENT_NOTICE message is sent after reconnect with correct payload", () => {
    const receivedPayloads: DocumentReplacementNoticePayload[] = [];
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
      onBootstrapApplied: () => {},
      onDocumentReplacementNotice: (payload) => {
        receivedPayloads.push(payload);
      },
    });

    const ws = connectProvider(provider);

    const restorePayload: DocumentReplacementNoticePayload = {
      message: "document was restored to an earlier version",
    };

    // DOCUMENT_REPLACEMENT_NOTICE is buffered until the live-sections
    // bootstrap (the sole join body fill) has applied
    ws.receiveServerMessage(encodeDocumentReplacementNotice(restorePayload));
    expect(receivedPayloads).toHaveLength(0); // Not delivered yet

    // Deliver the bootstrap — triggers pending notice delivery
    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].message).toBe("document was restored to an earlier version");

    const secondPayload: DocumentReplacementNoticePayload = {
      message: "admin overwrote this document",
    };

    // On an already-bootstrapped provider, a further bootstrap won't re-trigger
    // onBootstrapApplied, but it still consumes a newly buffered notice.
    ws.receiveServerMessage(encodeDocumentReplacementNotice(secondPayload));
    ws.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));

    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[1].message).toBe("admin overwrote this document");

    provider.destroy();
  });

  // ── A12.4 ─────────────────────────────────────────────────────────

  it("A12.4: replica-applied server updates are NOT relayed as local MSG_YJS_UPDATE; local edits still are", () => {
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {});
    const ws = connectProvider(provider);
    ws.sentMessages.length = 0;

    // A live-section frame applied by the replica (server-apply origin) must
    // never re-enter MSG_YJS_UPDATE ingress as a client edit.
    const serverDoc = new Y.Doc();
    serverDoc.getXmlFragment("section::alpha");
    serverDoc.getMap("meta").set("k", "server");
    const serverUpdate = Y.encodeStateAsUpdate(serverDoc);
    Y.applyUpdate(doc, serverUpdate, LIVE_SECTION_SERVER_APPLY_ORIGIN);
    expect(ws.sentMessages.filter((m) => m[0] === MSG_YJS_UPDATE)).toHaveLength(0);

    // A plain local transaction is still broadcast.
    doc.transact(() => {
      doc.getMap("meta").set("k2", "local");
    });
    expect(ws.sentMessages.filter((m) => m[0] === MSG_YJS_UPDATE)).toHaveLength(1);

    provider.destroy();
  });
});
