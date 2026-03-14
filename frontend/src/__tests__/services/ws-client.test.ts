import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import {
  KnowledgeStoreWsClient,
  __resetSessionWsManagerForTests,
} from "../../services/ws-client.js";

// Mock WebSocket globally to prevent real connection attempts from
// the BroadcastFallbackTransport (SharedWorker is unavailable in happy-dom).
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

  constructor(url: string | URL, _protocols?: string | string[]) {
    super();
    this.url = typeof url === "string" ? url : url.toString();
  }

  send(): void {
    // no-op in tests
  }

  close(): void {
    this.readyState = StubWebSocket.CLOSED;
  }
}

const originalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;

afterEach(() => {
  __resetSessionWsManagerForTests();
});

// Restore real WebSocket after all tests in this file (if needed by other suites).
// Vitest runs each file in isolation so this is mainly for correctness.
afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe("KnowledgeStoreWsClient", () => {
  it("can be instantiated", () => {
    const client = new KnowledgeStoreWsClient();
    expect(client).toBeDefined();
  });

  it("connect and disconnect do not throw", () => {
    const client = new KnowledgeStoreWsClient();
    expect(() => client.connect()).not.toThrow();
    expect(() => client.disconnect()).not.toThrow();
  });

  it("subscribe does not throw before connect", () => {
    const client = new KnowledgeStoreWsClient();
    expect(() => client.subscribe("docs/readme.md")).not.toThrow();
  });

  it("unsubscribe does not throw before connect", () => {
    const client = new KnowledgeStoreWsClient();
    expect(() => client.unsubscribe("docs/readme.md")).not.toThrow();
  });

  it("focusDocument does not throw before connect", () => {
    const client = new KnowledgeStoreWsClient();
    expect(() => client.focusDocument("docs/readme.md")).not.toThrow();
  });

  it("blurDocument does not throw before connect", () => {
    const client = new KnowledgeStoreWsClient();
    expect(() => client.blurDocument("docs/readme.md")).not.toThrow();
  });

  it("focusSection does not throw before connect", () => {
    const client = new KnowledgeStoreWsClient();
    expect(() => client.focusSection("docs/readme.md", ["Introduction"])).not.toThrow();
  });

  it("blurSection does not throw before connect", () => {
    const client = new KnowledgeStoreWsClient();
    expect(() => client.blurSection("docs/readme.md", ["Introduction"])).not.toThrow();
  });

  it("sessionDeparture does not throw before connect", () => {
    const client = new KnowledgeStoreWsClient();
    expect(() => client.sessionDeparture("docs/readme.md")).not.toThrow();
  });

  it("onEvent accepts a handler without throwing", () => {
    const client = new KnowledgeStoreWsClient();
    const handler = vi.fn();
    expect(() => client.onEvent(handler)).not.toThrow();
  });

  it("methods work after connect without throwing", () => {
    const client = new KnowledgeStoreWsClient();
    client.connect();
    expect(() => client.subscribe("docs/a.md")).not.toThrow();
    expect(() => client.unsubscribe("docs/a.md")).not.toThrow();
    expect(() => client.focusDocument("docs/a.md")).not.toThrow();
    expect(() => client.blurDocument("docs/a.md")).not.toThrow();
    expect(() => client.focusSection("docs/a.md", ["H1"])).not.toThrow();
    expect(() => client.blurSection("docs/a.md", ["H1"])).not.toThrow();
    expect(() => client.sessionDeparture("docs/a.md")).not.toThrow();
    client.disconnect();
  });

  it("__resetSessionWsManagerForTests cleans up without errors", () => {
    const client = new KnowledgeStoreWsClient();
    client.connect();
    client.subscribe("docs/x.md");
    expect(() => __resetSessionWsManagerForTests()).not.toThrow();
  });

  it("a new client works after reset", () => {
    const client1 = new KnowledgeStoreWsClient();
    client1.connect();
    __resetSessionWsManagerForTests();

    const client2 = new KnowledgeStoreWsClient();
    expect(() => client2.connect()).not.toThrow();
    expect(() => client2.disconnect()).not.toThrow();
  });
});
