/**
 * Group A12: Frontend Wire Protocol Invariant Tests
 *
 * Pre-refactor invariant tests for the binary message decoding in CrdtProvider.
 * These verify that encoded server messages are correctly decoded and dispatched
 * to the appropriate event callbacks with the expected payload shape.
 *
 * These must pass both before and after the store architecture refactor.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { CrdtProvider } from "../../services/crdt-provider";
import type { DocumentReplacementNoticePayload } from "../../types/shared";

// Protocol constants (must match crdt-provider.ts)
const MSG_SYNC_STEP_2 = 0x01;
const MSG_SESSION_OVERLAY_IMPORTED = 4;
const MSG_STRUCTURE_WILL_CHANGE = 8;
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0b;

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

// ─── Encode helpers (mirroring backend crdt-protocol.ts) ─────────

function encodeSessionOverlayImported(
  writtenKeys: string[],
  deletedKeys: string[],
): Uint8Array {
  let text = writtenKeys.join("\n");
  if (deletedKeys.length > 0) {
    text += "\x00" + deletedKeys.join("\n");
  }
  const payload = new TextEncoder().encode(text);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = MSG_SESSION_OVERLAY_IMPORTED;
  buf.set(payload, 1);
  return buf;
}

function encodeStructureWillChange(
  restructures: Array<{ oldKey: string; newKeys: string[] }>,
): Uint8Array {
  const json = JSON.stringify(restructures);
  const payload = new TextEncoder().encode(json);
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = MSG_STRUCTURE_WILL_CHANGE;
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

  it("A12.1: SESSION_OVERLAY_IMPORTED message contains correct writtenKeys and deletedKeys", () => {
    const receivedPayloads: Array<{ writtenKeys: string[]; deletedKeys: string[] }> = [];
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
      onSessionOverlayImported: (payload) => {
        receivedPayloads.push(payload);
      },
    });

    const ws = connectProvider(provider);

    // Test 1: Written keys only, no deletions
    ws.receiveServerMessage(
      encodeSessionOverlayImported(["frag:overview.md", "frag:timeline.md"], []),
    );
    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0].writtenKeys).toEqual(["frag:overview.md", "frag:timeline.md"]);
    expect(receivedPayloads[0].deletedKeys).toEqual([]);

    // Test 2: Both written and deleted keys
    ws.receiveServerMessage(
      encodeSessionOverlayImported(["frag:overview.md"], ["frag:old-section.md"]),
    );
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[1].writtenKeys).toEqual(["frag:overview.md"]);
    expect(receivedPayloads[1].deletedKeys).toEqual(["frag:old-section.md"]);

    // Test 3: Deleted keys only (empty written list)
    ws.receiveServerMessage(encodeSessionOverlayImported([], ["frag:removed.md"]));
    expect(receivedPayloads).toHaveLength(3);
    expect(receivedPayloads[2].writtenKeys).toEqual([]);
    expect(receivedPayloads[2].deletedKeys).toEqual(["frag:removed.md"]);

    provider.destroy();
  });

  // ── A12.2 ─────────────────────────────────────────────────────────

  it("A12.2: STRUCTURE_WILL_CHANGE message contains correct oldKey → newKeys remaps", () => {
    const receivedPayloads: Array<Array<{ oldKey: string; newKeys: string[] }>> = [];
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
      onStructureWillChange: (restructures) => {
        receivedPayloads.push(restructures);
      },
    });

    const ws = connectProvider(provider);

    // Test 1: Single split — one fragment becomes two
    ws.receiveServerMessage(
      encodeStructureWillChange([
        { oldKey: "frag:overview.md", newKeys: ["frag:overview.md", "frag:goals.md"] },
      ]),
    );
    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0]).toHaveLength(1);
    expect(receivedPayloads[0][0].oldKey).toBe("frag:overview.md");
    expect(receivedPayloads[0][0].newKeys).toEqual(["frag:overview.md", "frag:goals.md"]);

    // Test 2: Multiple restructures in a single message (e.g. multi-section normalize)
    ws.receiveServerMessage(
      encodeStructureWillChange([
        { oldKey: "frag:chapter1.md", newKeys: ["frag:chapter1.md", "frag:chapter1a.md"] },
        { oldKey: "frag:chapter2.md", newKeys: ["frag:chapter2-renamed.md"] },
      ]),
    );
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[1]).toHaveLength(2);
    expect(receivedPayloads[1][0].oldKey).toBe("frag:chapter1.md");
    expect(receivedPayloads[1][1].oldKey).toBe("frag:chapter2.md");
    expect(receivedPayloads[1][1].newKeys).toEqual(["frag:chapter2-renamed.md"]);

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
