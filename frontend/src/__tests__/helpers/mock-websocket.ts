type WebSocketData = string | ArrayBufferLike | Blob | ArrayBufferView;

export class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  static install(): () => void {
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    return () => {
      globalThis.WebSocket = originalWebSocket;
    };
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  readonly CONNECTING = MockWebSocket.CONNECTING;
  readonly OPEN = MockWebSocket.OPEN;
  readonly CLOSING = MockWebSocket.CLOSING;
  readonly CLOSED = MockWebSocket.CLOSED;

  readonly url: string;
  readonly protocol: string;
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";

  readyState = MockWebSocket.CONNECTING;

  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;

  sentMessages: WebSocketData[] = [];

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    this.url = typeof url === "string" ? url : url.toString();
    this.protocol = Array.isArray(protocols) ? protocols[0] ?? "" : protocols ?? "";
    MockWebSocket.instances.push(this);
  }

  send(data: WebSocketData): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("Cannot send while socket is not OPEN.");
    }
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    if (
      this.readyState === MockWebSocket.CLOSED ||
      this.readyState === MockWebSocket.CLOSING
    ) {
      return;
    }

    this.readyState = MockWebSocket.CLOSING;
    this.readyState = MockWebSocket.CLOSED;

    const event = createCloseEvent(code ?? 1000, reason ?? "");
    this.dispatchEvent(event);
    this.onclose?.call(this as unknown as WebSocket, event);
  }

  open(): void {
    if (this.readyState !== MockWebSocket.CONNECTING) {
      return;
    }

    this.readyState = MockWebSocket.OPEN;
    const event = new Event("open");
    this.dispatchEvent(event);
    this.onopen?.call(this as unknown as WebSocket, event);
  }

  emitError(): void {
    const event = new Event("error");
    this.dispatchEvent(event);
    this.onerror?.call(this as unknown as WebSocket, event);
  }

  receiveText(payload: string): void {
    const event = createMessageEvent(payload);
    this.dispatchEvent(event);
    this.onmessage?.call(this as unknown as WebSocket, event);
  }

  receiveJson(payload: unknown): void {
    this.receiveText(JSON.stringify(payload));
  }
}

function createMessageEvent(payload: string): MessageEvent {
  if (typeof MessageEvent === "function") {
    return new MessageEvent("message", { data: payload });
  }

  const event = new Event("message") as MessageEvent & { data: string };
  event.data = payload;
  return event;
}

function createCloseEvent(code: number, reason: string): CloseEvent {
  if (typeof CloseEvent === "function") {
    return new CloseEvent("close", { code, reason, wasClean: true });
  }

  const event = new Event("close") as CloseEvent & {
    code: number;
    reason: string;
    wasClean: boolean;
  };
  event.code = code;
  event.reason = reason;
  event.wasClean = true;
  return event;
}
