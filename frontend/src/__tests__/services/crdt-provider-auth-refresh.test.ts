/**
 * Tests for CRDT provider auth-expiry handling:
 *   - Close codes 4001 (AUTH_REQUIRED) and 4011 (AUTH_FAILED) trigger refresh-then-reconnect
 *   - Refresh failure stops reconnect and transitions to disconnected/error state
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as Y from "yjs";
import { CrdtProvider, type CrdtProviderEvents } from "../../services/crdt-provider";

// ─── StubWebSocket (same pattern as crdt-transport.test.ts) ─────

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

  static instances: StubWebSocket[] = [];

  constructor(url: string | URL) {
    super();
    this.url = typeof url === "string" ? url : url.toString();
    StubWebSocket.instances.push(this);
  }

  send(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === "string") return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.sentMessages.push(new Uint8Array(bytes));
  }

  close(): void {
    this.readyState = StubWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = StubWebSocket.OPEN;
    if (this.onopen) this.onopen(new Event("open"));
  }

  triggerClose(code: number, reason = ""): void {
    this.readyState = StubWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent("close", { code, reason }));
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

// ─── Mock apiClient.refreshAuthSession ─────────────────────────

const mockRefreshAuthSession = vi.fn<() => Promise<boolean>>();

vi.mock("../../services/api-client", () => ({
  apiClient: {
    refreshAuthSession: (...args: unknown[]) => mockRefreshAuthSession(...(args as [])),
  },
}));

// ─── Setup / teardown ──────────────────────────────────────────

beforeEach(() => {
  StubWebSocket.instances = [];
  mockRefreshAuthSession.mockReset();
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as any).crypto = {
      ...(globalThis.crypto ?? {}),
      randomUUID: () => "00000000-0000-0000-0000-000000000000",
    };
  }
  globalThis.WebSocket = StubWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  StubWebSocket.instances = [];
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
});

// ─── Helpers ───────────────────────────────────────────────────

function createProvider(events: CrdtProviderEvents = {}): CrdtProvider {
  const doc = new Y.Doc();
  return new CrdtProvider(doc, "/test/doc.md", events);
}

function connectProvider(provider: CrdtProvider): StubWebSocket {
  provider.connect();
  const ws = StubWebSocket.instances[StubWebSocket.instances.length - 1];
  ws.open();
  return ws;
}

// ─── Tests ─────────────────────────────────────────────────────

describe("CRDT provider auth-expiry handling", () => {
  it("attempts refresh on close code 4001 (AUTH_REQUIRED)", async () => {
    mockRefreshAuthSession.mockResolvedValue(true);

    const provider = createProvider();
    const ws = connectProvider(provider);
    ws.triggerClose(4001, "Auth required");

    // Wait for the async refresh
    await vi.waitFor(() => {
      expect(mockRefreshAuthSession).toHaveBeenCalledTimes(1);
    });

    provider.destroy();
  });

  it("attempts refresh on close code 4011 (AUTH_FAILED)", async () => {
    mockRefreshAuthSession.mockResolvedValue(true);

    const provider = createProvider();
    const ws = connectProvider(provider);
    ws.triggerClose(4011, "Auth failed");

    await vi.waitFor(() => {
      expect(mockRefreshAuthSession).toHaveBeenCalledTimes(1);
    });

    provider.destroy();
  });

  it("reconnects the WebSocket after successful refresh", async () => {
    mockRefreshAuthSession.mockResolvedValue(true);

    const provider = createProvider();
    const ws = connectProvider(provider);
    const instanceCountBefore = StubWebSocket.instances.length;

    ws.triggerClose(4001);

    await vi.waitFor(() => {
      // A new WebSocket should have been created for reconnect
      expect(StubWebSocket.instances.length).toBeGreaterThan(instanceCountBefore);
    });

    provider.destroy();
  });

  it("transitions to disconnected and fires onError when refresh fails", async () => {
    mockRefreshAuthSession.mockResolvedValue(false);

    const onError = vi.fn();
    const onStateChange = vi.fn();
    const provider = createProvider({ onError, onStateChange });
    const ws = connectProvider(provider);
    const instanceCountBefore = StubWebSocket.instances.length;

    ws.triggerClose(4001);

    await vi.waitFor(() => {
      expect(mockRefreshAuthSession).toHaveBeenCalledTimes(1);
    });

    // Should have called onError with auth-related message
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith("Authentication expired");
    });

    // Should NOT have created a new WebSocket (no reconnect)
    expect(StubWebSocket.instances.length).toBe(instanceCountBefore);

    // State should be disconnected
    expect(onStateChange).toHaveBeenCalledWith("disconnected");

    provider.destroy();
  });

  it("does NOT attempt refresh for non-auth close codes (e.g. idle timeout 4020)", async () => {
    const onIdleTimeout = vi.fn();
    const provider = createProvider({ onIdleTimeout });
    const ws = connectProvider(provider);

    ws.triggerClose(4020, "Idle timeout");

    // Give async handlers time to fire
    await new Promise((r) => setTimeout(r, 50));

    expect(mockRefreshAuthSession).not.toHaveBeenCalled();
    expect(onIdleTimeout).toHaveBeenCalledTimes(1);

    provider.destroy();
  });

  it("does NOT attempt refresh for server-reject close codes (e.g. 4010 invalid URL)", async () => {
    const onError = vi.fn();
    const provider = createProvider({ onError });
    const ws = connectProvider(provider);

    ws.triggerClose(4010, "Invalid URL");

    await new Promise((r) => setTimeout(r, 50));

    expect(mockRefreshAuthSession).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Invalid URL");

    provider.destroy();
  });
});
