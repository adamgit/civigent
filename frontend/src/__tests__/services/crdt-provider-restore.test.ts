import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { CrdtProvider } from "../../services/crdt-provider";
import type { DocumentReplacementNoticePayload } from "../../types/shared";
import { WS_CLOSE_DOCUMENT_REPLACED, WS_CLOSE_ADMIN_REBUILD, WS_CLOSE_SUPERSEDED } from "../../services/crdt-close-codes";

// Protocol message types (must match crdt-provider.ts)
const MSG_SYNC_STEP_1 = 0x00;
const MSG_SYNC_STEP_2 = 0x01;
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0b;
const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;

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

describe("CrdtProvider document replacement notice handling", () => {
  it("notice-before-bootstrap ordering: onDocumentReplacementNotice fires once the live-sections bootstrap applies", () => {
    const onRestore = vi.fn();
    const onBootstrapApplied = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onBootstrapApplied, onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    // Server sends MSG_DOCUMENT_REPLACEMENT_NOTICE first, then the bootstrap
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
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
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

  it("a later barrier SYNC_STEP_2 does NOT release a buffered notice (bootstrap-only release)", () => {
    const onRestore = vi.fn();
    const onBootstrapApplied = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onBootstrapApplied, onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    ws.receiveServerMessage(buildDocumentReplacementNotice(VALID_NOTICE_PAYLOAD));
    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildSyncStep2FromDoc(sourceDoc));

    // A barrier diff is not the join body fill — the notice stays buffered.
    expect(onBootstrapApplied).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();

    ws.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));
    expect(onBootstrapApplied).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it("normal bootstrap without notice: onBootstrapApplied fires, onDocumentReplacementNotice does NOT fire", () => {
    const onRestore = vi.fn();
    const onBootstrapApplied = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onBootstrapApplied, onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));

    expect(onBootstrapApplied).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("multiple bootstrap frames: onBootstrapApplied fires exactly once", () => {
    const onBootstrapApplied = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onBootstrapApplied });

    provider.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();

    const sourceDoc = new Y.Doc();
    ws.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));
    ws.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));

    expect(onBootstrapApplied).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it("pendingDocumentReplacementNotice is reset on a new connection", () => {
    const onRestore = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onDocumentReplacementNotice: onRestore });

    provider.connect();
    const ws1 = StubWebSocket.lastInstance!;
    ws1.open();

    // Receive a notice on the first connection (but no bootstrap yet)
    ws1.receiveServerMessage(buildDocumentReplacementNotice(VALID_NOTICE_PAYLOAD));

    // Reconnect via the consumer path (disconnect + connect).
    provider.disconnect();
    provider.connect();
    const ws2 = StubWebSocket.lastInstance!;
    expect(ws2).not.toBe(ws1);
    ws2.open();

    // Bootstrap on the NEW connection — onDocumentReplacementNotice should NOT fire
    // because pendingDocumentReplacementNotice was cleared in onopen.
    const sourceDoc = new Y.Doc();
    ws2.receiveServerMessage(buildLiveSectionsBootstrapFromDoc(sourceDoc));

    expect(onRestore).not.toHaveBeenCalled();
    provider.destroy();
  });

  it("admin force-rebuild (4024) fires onForceRebuild and does NOT reconnect the old doc, like 4022", () => {
    const onForceRebuild = vi.fn();
    const onSessionReinit = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onForceRebuild, onSessionReinit });

    provider.connect();
    const ws1 = StubWebSocket.lastInstance!;
    ws1.open();

    // Server sends the admin force-rebuild close code.
    ws1.onclose?.(new CloseEvent("close", { code: WS_CLOSE_ADMIN_REBUILD }));

    // Behaves like 4022: NO new WebSocket is opened against the old Y.Doc —
    // the consumer replaces the whole live pipeline. onForceRebuild fires
    // (not the restore-specific onSessionReinit).
    expect(StubWebSocket.lastInstance).toBe(ws1);
    expect(onForceRebuild).toHaveBeenCalledTimes(1);
    expect(onSessionReinit).not.toHaveBeenCalled();
    expect(provider.state).toBe("disconnected");
    provider.destroy();
  });

  it("restore (4022) fires onSessionReinit and does NOT reconnect the old doc", () => {
    const onSessionReinit = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onSessionReinit });

    provider.connect();
    const ws1 = StubWebSocket.lastInstance!;
    ws1.open();
    ws1.onclose?.(new CloseEvent("close", { code: WS_CLOSE_DOCUMENT_REPLACED }));

    // No reconnect: the old Y.Doc must never regain a socket after replacement.
    expect(StubWebSocket.lastInstance).toBe(ws1);
    expect(onSessionReinit).toHaveBeenCalledTimes(1);
    expect(provider.state).toBe("disconnected");
    provider.destroy();
  });

  it("superseded (4023) fires onSuperseded, does NOT reconnect, and does NOT surface a generic error", () => {
    const onSuperseded = vi.fn();
    const onError = vi.fn();
    const onSessionReinit = vi.fn();
    const onForceRebuild = vi.fn();
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md", {
      onSuperseded,
      onError,
      onSessionReinit,
      onForceRebuild,
    });

    provider.connect();
    const ws1 = StubWebSocket.lastInstance!;
    ws1.open();

    ws1.onclose?.(new CloseEvent("close", { code: WS_CLOSE_SUPERSEDED }));

    // No new WebSocket was opened — this is not a reconnect.
    expect(StubWebSocket.lastInstance).toBe(ws1);
    expect(onSuperseded).toHaveBeenCalledTimes(1);
    // 4023 is not a transport failure: no generic error surface, no restore/rebuild.
    expect(onError).not.toHaveBeenCalled();
    expect(onSessionReinit).not.toHaveBeenCalled();
    expect(onForceRebuild).not.toHaveBeenCalled();
    expect(provider.state).toBe("disconnected");
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
