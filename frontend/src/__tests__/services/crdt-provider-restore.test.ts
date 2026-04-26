import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { CrdtProvider } from "../../services/crdt-provider";
import type { DocumentReplacementNoticePayload } from "../../types/shared";
import { WS_CLOSE_DOCUMENT_REPLACED } from "../../services/crdt-close-codes";

// Protocol message types (must match crdt-provider.ts)
const MSG_SYNC_STEP_1 = 0x00;
const MSG_SYNC_STEP_2 = 0x01;
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0b;

// ─── StubWebSocket ──────────────────────────────────────────────
// Replaces globalThis.WebSocket so CrdtProvider's `new WebSocket(url)` returns
// a controllable stub. Tests trigger onopen/onmessage/onclose manually.

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

  /** Messages the SUT (provider) sent to the server. */
  sentMessages: Uint8Array[] = [];
  /** Number of times close() was called. */
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

  /** Test helper: simulate the server sending a binary message. */
  receiveServerMessage(bytes: Uint8Array): void {
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }));
    }
  }

  /** Test helper: open the connection (simulates server accept). */
  open(): void {
    this.readyState = StubWebSocket.OPEN;
    if (this.onopen) this.onopen(new Event("open"));
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  StubWebSocket.lastInstance = null;
  globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
  // Stub crypto.randomUUID for happy-dom which may not provide it
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto: Crypto }).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => "test-uuid-1234",
    } as Crypto;
  }
});

afterEach(() => {
  StubWebSocket.lastInstance = null;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
});

/** Build the byte payload for a MSG_DOCUMENT_REPLACEMENT_NOTICE message. */
function buildDocumentReplacementNotice(payload: DocumentReplacementNoticePayload): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = MSG_DOCUMENT_REPLACEMENT_NOTICE;
  msg.set(json, 1);
  return msg;
}

/** Build the byte payload for a MSG_SYNC_STEP_2 message from a source Y.Doc. */
function buildSyncStep2FromDoc(sourceDoc: Y.Doc): Uint8Array {
  const update = Y.encodeStateAsUpdate(sourceDoc);
  const msg = new Uint8Array(1 + update.length);
  msg[0] = MSG_SYNC_STEP_2;
  msg.set(update, 1);
  return msg;
}

const VALID_NOTICE_PAYLOAD: DocumentReplacementNoticePayload = {
  message: "document was restored to an earlier version",
};

describe("CrdtProvider document replacement notice handling", () => {
  it("notice-before-sync ordering: onDocumentReplacementNotice fires on SYNC_STEP_2 receipt", () => {
    const onRestore = vi.fn();
    const onSynced = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onSynced, onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    // Server sends MSG_DOCUMENT_REPLACEMENT_NOTICE first, then MSG_SYNC_STEP_2
    ws.receiveServerMessage(buildDocumentReplacementNotice(VALID_NOTICE_PAYLOAD));
    const sourceDoc = new Y.Doc();
    sourceDoc.getMap("test").set("k", "v");
    ws.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith(VALID_NOTICE_PAYLOAD);

    provider.destroy();
  });

  it("onSynced fires before onDocumentReplacementNotice when both trigger on same SYNC_STEP_2", () => {
    const log: string[] = [];
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
      onSynced: () => log.push("synced"),
      onDocumentReplacementNotice: () => log.push("noticed"),
    });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    ws.receiveServerMessage(buildDocumentReplacementNotice(VALID_NOTICE_PAYLOAD));
    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    expect(log).toEqual(["synced", "noticed"]);
    provider.destroy();
  });

  it("normal sync without notice: onSynced fires, onDocumentReplacementNotice does NOT fire", () => {
    const onRestore = vi.fn();
    const onSynced = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onSynced, onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("multiple SYNC_STEP_2 messages: onSynced fires exactly once", () => {
    const onSynced = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onSynced });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));
    ws.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    expect(onSynced).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it("pendingDocumentReplacementNotice is reset on reconnect", () => {
    const onRestore = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws1 = StubWebSocket.lastInstance!;
    ws1.open();

    // Receive a notice on the first connection (but no SYNC_STEP_2 yet)
    ws1.receiveServerMessage(buildDocumentReplacementNotice(VALID_NOTICE_PAYLOAD));

    // Server sends close code 4022 — provider auto-reconnects
    if (ws1.onclose) {
      ws1.onclose(new CloseEvent("close", { code: WS_CLOSE_DOCUMENT_REPLACED }));
    }

    // Provider opens a new WebSocket
    const ws2 = StubWebSocket.lastInstance!;
    expect(ws2).not.toBe(ws1);
    ws2.open();

    // Send SYNC_STEP_2 on the NEW connection — onDocumentReplacementNotice should NOT fire
    // because pendingDocumentReplacementNotice was cleared in onopen.
    const sourceDoc = new Y.Doc();
    ws2.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    expect(onRestore).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("MSG_DOCUMENT_REPLACEMENT_NOTICE with malformed JSON closes the socket", () => {
    const onError = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onError });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    // Send a MSG_DOCUMENT_REPLACEMENT_NOTICE with invalid JSON in the payload
    const invalidJson = new TextEncoder().encode("{not valid json");
    const msg = new Uint8Array(1 + invalidJson.length);
    msg[0] = MSG_DOCUMENT_REPLACEMENT_NOTICE;
    msg.set(invalidJson, 1);
    ws.receiveServerMessage(msg);

    expect(ws.closeCallCount).toBeGreaterThan(0);
    expect(onError).toHaveBeenCalled();
    provider.destroy();
  });
});
