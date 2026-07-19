import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { ObserverCrdtProvider } from "../../services/observer-crdt-provider";
import type { DocumentReplacementNoticePayload } from "../../types/shared";
import { WS_CLOSE_DOCUMENT_REPLACED, WS_CLOSE_ADMIN_REBUILD } from "../../services/crdt-close-codes";

const MSG_SYNC_STEP_1 = 0x00;
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0b;
const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;

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

/** Build a MSG_LIVE_SECTIONS_BOOTSTRAP frame — the sole join body fill that
 *  releases bootstrapApplied/buffered-notice on the provider. */
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

const VALID_NOTICE_PAYLOAD: DocumentReplacementNoticePayload = {
  message: "document was restored to an earlier version",
};

describe("ObserverCrdtProvider document replacement notice handling", () => {
  it("notice-before-bootstrap ordering: onDocumentReplacementNotice fires once the live-sections bootstrap applies", () => {
    const onRestore = vi.fn();
    const onBootstrapApplied = vi.fn();
    const provider = new ObserverCrdtProvider("/test/doc.md", { onBootstrapApplied, onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    ws.receiveServerMessage(buildDocumentReplacementNotice(VALID_NOTICE_PAYLOAD));
    expect(onRestore).not.toHaveBeenCalled();
    const sourceDoc = new Y.Doc();
    sourceDoc.getMap("test").set("k", "v");
    ws.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));

    expect(onBootstrapApplied).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith(VALID_NOTICE_PAYLOAD);

    provider.destroy();
  });

  it("onBootstrapApplied fires before onDocumentReplacementNotice when both trigger on the same bootstrap", () => {
    const log: string[] = [];
    const provider = new ObserverCrdtProvider("/test/doc.md", {
      onBootstrapApplied: () => log.push("bootstrapApplied"),
      onDocumentReplacementNotice: () => log.push("noticed"),
    });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    ws.receiveServerMessage(buildDocumentReplacementNotice(VALID_NOTICE_PAYLOAD));
    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));

    expect(log).toEqual(["bootstrapApplied", "noticed"]);
    provider.destroy();
  });

  it("normal bootstrap without notice: onBootstrapApplied fires, onDocumentReplacementNotice does NOT fire", () => {
    const onRestore = vi.fn();
    const onBootstrapApplied = vi.fn();
    const provider = new ObserverCrdtProvider("/test/doc.md", { onBootstrapApplied, onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));

    expect(onBootstrapApplied).toHaveBeenCalledTimes(1);
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
    ws2.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));

    expect(onRestore).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("admin force-rebuild (4024) reconnects the observer immediately, like 4022", () => {
    const onSessionReinit = vi.fn();
    const provider = new ObserverCrdtProvider("/test/doc.md", { onSessionReinit });

    provider.connect();
    const ws1 = StubWebSocket.lastInstance!;
    ws1.open();

    ws1.onclose?.(new CloseEvent("close", { code: WS_CLOSE_ADMIN_REBUILD }));

    const ws2 = StubWebSocket.lastInstance!;
    expect(ws2).not.toBe(ws1);
    expect(onSessionReinit).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it("observer fails loud on illegal server MSG_SYNC_STEP_1", () => {
    const errors: string[] = [];
    const provider = new ObserverCrdtProvider("/test/doc.md", {
      onError: (reason) => errors.push(reason),
    });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    expect(ws.sentMessages.length).toBe(1);
    expect(ws.sentMessages.some((m) => m[0] === MSG_SYNC_STEP_1)).toBe(false);

    const serverStateVector = Y.encodeStateVector(new Y.Doc());
    const msg = new Uint8Array(1 + serverStateVector.length);
    msg[0] = MSG_SYNC_STEP_1;
    msg.set(serverStateVector, 1);
    ws.receiveServerMessage(msg);

    expect(errors.some((e) => e.includes("Unexpected CRDT opcode 0x0"))).toBe(true);
    expect(ws.closeCallCount).toBeGreaterThan(0);
    provider.destroy();
  });
});
