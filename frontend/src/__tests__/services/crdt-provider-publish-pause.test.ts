/**
 * Publish-pause quiescence-barrier tests for CrdtProvider.
 *
 * Spec 05-ydoc-lifecycle §"DocSession publish pause messages":
 *   - doc_publish_pause_start freezes all mounted + future-mounted editors.
 *   - doc_publish_ready is sent (client → server) exactly once per pause, only
 *     after the client has stopped producing Yjs transactions — coordinated via
 *     the provider-owned PublishPauseBarrier the editor registry sets.
 *   - Editors unfreeze only on doc_publish_pause_end.
 *   - A pause_end without a prior pause_start still notifies (mid-pause joiner
 *     recovery) without ever sending doc_publish_ready.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { CrdtProvider, type PublishPauseBarrier } from "../../services/crdt-provider";

const MSG_SYNC_STEP_2 = 0x01;
const MSG_DOC_PUBLISH_PAUSE_START = 0x10;
const MSG_DOC_PUBLISH_READY = 0x11;
const MSG_DOC_PUBLISH_PAUSE_END = 0x12;

class StubWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly url: string;
  binaryType: BinaryType = "blob";
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  sentMessages: Uint8Array[] = [];
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
  close(): void { this.readyState = StubWebSocket.CLOSED; }
  receiveServerMessage(bytes: Uint8Array): void {
    this.onmessage?.(new MessageEvent("message", {
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));
  }
  open(): void {
    this.readyState = StubWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
}

const originalWebSocket = globalThis.WebSocket;

function buildSyncStep2(): Uint8Array {
  const d = new Y.Doc();
  const state = Y.encodeStateAsUpdate(d);
  const msg = new Uint8Array(1 + state.length);
  msg[0] = MSG_SYNC_STEP_2;
  msg.set(state, 1);
  d.destroy();
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

afterEach(() => { StubWebSocket.lastInstance = null; });
afterAll(() => { globalThis.WebSocket = originalWebSocket; });

function connect(provider: CrdtProvider): StubWebSocket {
  provider.connect();
  const ws = StubWebSocket.lastInstance!;
  ws.open();
  ws.receiveServerMessage(buildSyncStep2());
  return ws;
}

function readyFrames(ws: StubWebSocket): Uint8Array[] {
  return ws.sentMessages.filter((m) => m[0] === MSG_DOC_PUBLISH_READY);
}

describe("CrdtProvider publish-pause quiescence barrier", () => {
  it("with no barrier: pause_start sends ready immediately, exactly once", () => {
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md");
    const ws = connect(provider);
    ws.sentMessages.length = 0;

    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
    expect(readyFrames(ws).length).toBe(1);
    expect(provider.isPublishPaused).toBe(true);

    provider.destroy();
  });

  it("freezes editors then sends ready exactly once after quiescence settles", async () => {
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md");
    const ws = connect(provider);
    ws.sentMessages.length = 0;

    let resolveFreeze!: () => void;
    const freeze = vi.fn(() => new Promise<void>((r) => { resolveFreeze = r; }));
    const unfreeze = vi.fn();
    const barrier: PublishPauseBarrier = { freeze, unfreeze };
    provider.setPublishPauseBarrier(barrier);

    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
    // Editors frozen; ready NOT yet sent (quiescence not settled).
    expect(freeze).toHaveBeenCalledTimes(1);
    expect(readyFrames(ws).length).toBe(0);

    // Quiescence settles → ready sent exactly once.
    resolveFreeze();
    await Promise.resolve();
    await Promise.resolve();
    expect(readyFrames(ws).length).toBe(1);

    // Still frozen until pause_end.
    expect(unfreeze).not.toHaveBeenCalled();

    provider.destroy();
  });

  it("a duplicate pause_start does not re-freeze or send a second ready", () => {
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md");
    const ws = connect(provider);
    ws.sentMessages.length = 0;

    const freeze = vi.fn(() => Promise.resolve());
    provider.setPublishPauseBarrier({ freeze, unfreeze: vi.fn() });

    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
    expect(freeze).toHaveBeenCalledTimes(1);

    provider.destroy();
  });

  it("unfreezes only on pause_end", async () => {
    const doc = new Y.Doc();
    const provider = new CrdtProvider(doc, "/test/doc.md");
    const ws = connect(provider);

    const unfreeze = vi.fn();
    provider.setPublishPauseBarrier({ freeze: () => Promise.resolve(), unfreeze });

    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_START]));
    await Promise.resolve();
    expect(unfreeze).not.toHaveBeenCalled();

    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]));
    expect(unfreeze).toHaveBeenCalledTimes(1);
    expect(provider.isPublishPaused).toBe(false);

    provider.destroy();
  });

  it("pause_end without a prior pause_start still notifies (mid-pause joiner recovery) and never sends ready", () => {
    const doc = new Y.Doc();
    const onPublishPauseEnd = vi.fn();
    const provider = new CrdtProvider(doc, "/test/doc.md", { onPublishPauseEnd });
    const ws = connect(provider);

    const unfreeze = vi.fn();
    provider.setPublishPauseBarrier({ freeze: () => Promise.resolve(), unfreeze });

    const sentBefore = ws.sentMessages.length;
    ws.receiveServerMessage(new Uint8Array([MSG_DOC_PUBLISH_PAUSE_END]));
    expect(unfreeze).toHaveBeenCalledTimes(1);
    expect(onPublishPauseEnd).toHaveBeenCalledTimes(1);
    expect(provider.isPublishPaused).toBe(false);
    expect(ws.sentMessages.length).toBe(sentBefore);

    provider.destroy();
  });
});
