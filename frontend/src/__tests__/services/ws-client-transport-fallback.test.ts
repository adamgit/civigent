import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  KnowledgeStoreWsClient,
  __resetSessionWsManagerForTests,
} from "../../services/ws-client.js";
import { clearWsDiag, listWsDiagEntries } from "../../services/ws-diagnostics.js";

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
  readyState = StubWebSocket.CONNECTING;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  constructor(url: string | URL) {
    super();
    this.url = typeof url === "string" ? url : url.toString();
  }
  send(): void {}
  close(): void {
    this.readyState = StubWebSocket.CLOSED;
  }
}

const originalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;

interface FakePortRecord {
  messageListeners: Array<(ev: MessageEvent) => void>;
  messageerrorListeners: Array<(ev: Event) => void>;
  sent: unknown[];
  emitMessage(data: unknown): void;
}

interface FakeWorkerRecord {
  errorListeners: Array<(ev: Event) => void>;
  port: FakePortRecord;
  emitError(message: string): void;
}

let fakeWorker: FakeWorkerRecord | null = null;

function makeFakeWorker(): { record: FakeWorkerRecord; impl: unknown } {
  const port: FakePortRecord = {
    messageListeners: [],
    messageerrorListeners: [],
    sent: [],
    emitMessage(data: unknown) {
      const ev = { data } as unknown as MessageEvent;
      for (const l of this.messageListeners) l(ev);
    },
  };
  const record: FakeWorkerRecord = {
    errorListeners: [],
    port,
    emitError(message: string) {
      const ev = new Event("error") as unknown as ErrorEvent;
      Object.defineProperty(ev, "message", { value: message });
      for (const l of this.errorListeners) l(ev);
    },
  };
  const portImpl = {
    start: () => {},
    close: () => {},
    postMessage: (message: unknown) => {
      port.sent.push(message);
    },
    addEventListener: (type: string, handler: (ev: Event) => void) => {
      if (type === "message") port.messageListeners.push(handler as (ev: MessageEvent) => void);
      if (type === "messageerror") port.messageerrorListeners.push(handler);
    },
  };
  const workerImpl = {
    port: portImpl,
    addEventListener: (type: string, handler: (ev: Event) => void) => {
      if (type === "error") record.errorListeners.push(handler);
    },
  };
  return { record, impl: workerImpl };
}

function installSharedWorkerMock(mode: "sync-throw" | "ok"): void {
  (window as unknown as { SharedWorker?: unknown }).SharedWorker = function MockSharedWorker() {
    if (mode === "sync-throw") {
      throw new Error("sync construction failure");
    }
    const { record, impl } = makeFakeWorker();
    fakeWorker = record;
    return impl as unknown as SharedWorker;
  } as unknown as new (...args: unknown[]) => SharedWorker;
}

function uninstallSharedWorkerMock(): void {
  delete (window as unknown as { SharedWorker?: unknown }).SharedWorker;
  fakeWorker = null;
}

function diagTypes(): string[] {
  return listWsDiagEntries()
    .filter((e) => e.source === "ws-lifecycle")
    .map((e) => {
      const payload = e.payload as { transport?: string } | null | undefined;
      return `${e.type}:${payload?.transport ?? ""}`;
    });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  clearWsDiag();
});

afterEach(() => {
  __resetSessionWsManagerForTests();
  uninstallSharedWorkerMock();
  vi.useRealTimers();
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe("WsClient transport acquisition", () => {
  it("falls back when SharedWorker constructor throws synchronously", async () => {
    installSharedWorkerMock("sync-throw");

    const client = new KnowledgeStoreWsClient();
    client.connect();
    await flushMicrotasks();

    const types = diagTypes();
    expect(types).toContain("session_attempting:shared-worker");
    expect(types).toContain("transport_failed:shared-worker");
    expect(types).toContain("session_attempting:broadcast-fallback");
    expect(types).toContain("session_acquired:broadcast-fallback");
    expect(types).not.toContain("session_acquired:shared-worker");

    client.disconnect();
  });

  it("falls back when SharedWorker emits an async error event", async () => {
    installSharedWorkerMock("ok");

    const client = new KnowledgeStoreWsClient();
    client.connect();
    await flushMicrotasks();

    expect(fakeWorker).not.toBeNull();
    fakeWorker!.emitError("worker boot failed");
    await flushMicrotasks();

    const types = diagTypes();
    expect(types).toContain("session_attempting:shared-worker");
    expect(types).toContain("transport_failed:shared-worker");
    expect(types).toContain("session_attempting:broadcast-fallback");
    expect(types).toContain("session_acquired:broadcast-fallback");

    const failedEntry = listWsDiagEntries().find((e) => e.type === "transport_failed");
    expect(failedEntry).toBeDefined();
    const payload = failedEntry!.payload as { reason: string };
    expect(payload.reason).toContain("worker boot failed");

    client.disconnect();
  });

  it("falls back when register_ack never arrives within the handshake timeout", async () => {
    vi.useFakeTimers();
    installSharedWorkerMock("ok");

    const client = new KnowledgeStoreWsClient();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeWorker).not.toBeNull();

    // Do NOT emit register_ack. Advance past the 3s handshake timeout.
    await vi.advanceTimersByTimeAsync(3100);
    await vi.advanceTimersByTimeAsync(0);

    const types = diagTypes();
    expect(types).toContain("transport_failed:shared-worker");
    expect(types).toContain("session_attempting:broadcast-fallback");
    expect(types).toContain("session_acquired:broadcast-fallback");

    const failedEntry = listWsDiagEntries().find((e) => e.type === "transport_failed");
    const payload = failedEntry!.payload as { reason: string };
    expect(payload.reason).toMatch(/timeout/i);

    client.disconnect();
  });

  it("stays on shared-worker when register_ack arrives before the timeout", async () => {
    installSharedWorkerMock("ok");

    const client = new KnowledgeStoreWsClient();
    client.connect();
    await flushMicrotasks();

    expect(fakeWorker).not.toBeNull();
    fakeWorker!.port.emitMessage({ type: "register_ack" });
    await flushMicrotasks();

    const types = diagTypes();
    expect(types).toContain("session_attempting:shared-worker");
    expect(types).toContain("session_acquired:shared-worker");
    expect(types).not.toContain("transport_failed:shared-worker");
    expect(types).not.toContain("session_attempting:broadcast-fallback");

    client.disconnect();
  });
});
