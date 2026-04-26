import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { ObserverCrdtProvider } from "../../services/observer-crdt-provider";
import type { DocumentReplacementNoticePayload } from "../../types/shared";
import { WS_CLOSE_DOCUMENT_REPLACED } from "../../services/crdt-close-codes";

const MSG_SYNC_STEP_1 = 0x00;
const MSG_SYNC_STEP_2 = 0x01;
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0b;

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
      this.onmessage(new MessageEvent("message", { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }));
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

function buildDocumentReplacementNotice(payload: DocumentReplacementNoticePayload): Uint8Array {
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

const VALID_NOTICE_PAYLOAD: DocumentReplacementNoticePayload = {
  message: "document was restored to an earlier version",
};

describe("ObserverCrdtProvider document replacement notice handling", () => {
  it("notice-before-sync ordering: onDocumentReplacementNotice fires on SYNC_STEP_2 receipt", () => {
    const onRestore = vi.fn();
    const onSynced = vi.fn();
    const provider = new ObserverCrdtProvider("/test/doc.md", { onSynced, onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

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
    const provider = new ObserverCrdtProvider("/test/doc.md", {
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
    const provider = new ObserverCrdtProvider("/test/doc.md", { onSynced, onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("pendingDocumentReplacementNotice is reset on reconnect (close code 4022)", () => {
    const onRestore = vi.fn();
    const provider = new ObserverCrdtProvider("/test/doc.md", { onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws1 = StubWebSocket.lastInstance!;
    ws1.open();

    ws1.receiveServerMessage(buildDocumentReplacementNotice(VALID_NOTICE_PAYLOAD));

    if (ws1.onclose) {
      ws1.onclose(new CloseEvent("close", { code: WS_CLOSE_DOCUMENT_REPLACED }));
    }

    const ws2 = StubWebSocket.lastInstance!;
    expect(ws2).not.toBe(ws1);
    ws2.open();

    const sourceDoc = new Y.Doc();
    ws2.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    expect(onRestore).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("observer ignores server's MSG_SYNC_STEP_1 (does not reply)", () => {
    const provider = new ObserverCrdtProvider("/test/doc.md", {});

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    // After open, the observer has already sent MODE_TRANSITION_REQUEST + its own SYNC_STEP_1.
    // Capture the baseline count.
    const baselineCount = ws.sentMessages.length;
    expect(baselineCount).toBeGreaterThan(0);

    // Server sends MSG_SYNC_STEP_1 (asking observer for state). Observer should NOT respond.
    const serverStateVector = Y.encodeStateVector(new Y.Doc());
    const msg = new Uint8Array(1 + serverStateVector.length);
    msg[0] = MSG_SYNC_STEP_1;
    msg.set(serverStateVector, 1);
    ws.receiveServerMessage(msg);

    // Verify no new send() calls were made
    expect(ws.sentMessages.length).toBe(baselineCount);
    provider.destroy();
  });
});
