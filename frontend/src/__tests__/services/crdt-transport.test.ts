/**
 * Unit tests for CrdtTransport.
 *
 * Covers:
 *   - Transport surfaces connection/bootstrap/error through its option callbacks
 *   - DocSession publish-pause frames route to the pause callbacks and the
 *     doc_publish_ready ack
 *
 * The legacy SESSION_OVERLAY_IMPORTED / STRUCTURE_WILL_CHANGE / receipt
 * plumbing is removed (spec 05 §4 > Removed message types). Section block-state
 * (`section:*`) rides the JSON application WebSocket, not this binary channel.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { CrdtTransport, type CrdtTransportOptions } from "../../services/crdt-transport.js";
import type { CrdtConnectionState } from "../../services/crdt-provider.js";

// Protocol message types (must match crdt-provider.ts / crdt-ws-frames.ts)
const MSG_SYNC_STEP_2 = 0x01;
const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;
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

/** The sole join body fill — flips the provider's bootstrapApplied flag. */
function buildLiveSectionsBootstrap(doc?: Y.Doc): Uint8Array {
  const d = doc ?? new Y.Doc();
  const update = Y.encodeStateAsUpdate(d);
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

  function makeTransport(opts: CrdtTransportOptions = {}): CrdtTransport {
    transport = new CrdtTransport("/test/doc.md", opts);
    return transport;
  }

  function connectAndSync(): StubWebSocket {
    transport.connect();
    const ws = StubWebSocket.lastInstance!;
    ws.open();
    ws.receiveServerMessage(buildLiveSectionsBootstrap());
    return ws;
  }

  afterEach(() => {
    transport.destroy();
  });

  describe("connection state routing", () => {
    it("surfaces connection state through onStateChange and transport.state", () => {
      const states: CrdtConnectionState[] = [];
      makeTransport({ onStateChange: (s) => states.push(s) });
      transport.connect();
      expect(transport.state).toBe("connecting");
      const ws = StubWebSocket.lastInstance!;
      ws.open();
      expect(transport.state).toBe("connected");
      expect(states).toEqual(["connecting", "connected"]);
    });

    it("fires onBootstrapApplied once the live-sections bootstrap applies", () => {
      const onBootstrapApplied = vi.fn();
      makeTransport({ onBootstrapApplied });
      transport.connect();
      const ws = StubWebSocket.lastInstance!;
      ws.open();
      expect(onBootstrapApplied).not.toHaveBeenCalled();
      ws.receiveServerMessage(buildLiveSectionsBootstrap());
      expect(onBootstrapApplied).toHaveBeenCalledTimes(1);
    });

    it("surfaces close reasons through onError", () => {
      const onError = vi.fn();
      makeTransport({ onError });
      transport.connect();
      const ws = StubWebSocket.lastInstance!;
      ws.readyState = StubWebSocket.CLOSED;
      ws.onclose?.(new CloseEvent("close", { code: 4010, reason: "Invalid URL" }));
      expect(onError).toHaveBeenCalledWith("Invalid URL");
    });
  });

  describe("DocSession publish-pause routing", () => {
    it("invokes the onPublishPauseStart/End passthroughs", () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      makeTransport({ onPublishPauseStart: onStart, onPublishPauseEnd: onEnd });
      transport.connect();
      const ws = StubWebSocket.lastInstance!;
      ws.open();
      ws.receiveServerMessage(buildSyncStep2());
      ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
      ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]));
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("sends doc_publish_ready exactly once after pause_start (no editor barrier)", () => {
      makeTransport();
      const ws = connectAndSync();
      ws.sentMessages.length = 0;
      ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
      const readyFrames = ws.sentMessages.filter((m) => m[0] === MSG_DOC_PUBLISH_READY);
      expect(readyFrames.length).toBe(1);
    });
  });
});
