import type { WsClientMessage, WsServerEvent } from "../types/shared.js";

/**
 * Envelope carrying a private origin-only app event across the shared
 * WebSocket. The backend hub emits this shape via `sendPrivate(...)` so the
 * shared-worker layer can forward the inner event ONLY to the tab whose
 * `clientInstanceId` matches — other tabs sharing the same socket must not
 * observe the rejection payload. Envelope-first delivery avoids leaking
 * semantic rejection explanations across tabs of the same writer.
 */
interface PrivateEnvelope {
  __private__: true;
  target_client_instance_id: string;
  event: WsServerEvent;
}

export function isPrivateEnvelope(value: unknown): value is PrivateEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __private__?: unknown }).__private__ === true &&
    typeof (value as { target_client_instance_id?: unknown }).target_client_instance_id === "string"
  );
}
import { randomUuid } from "../utils/random-uuid";
import { recordWsDiag, type WsDiagSource } from "./ws-diagnostics";

export type WsEventHandler = (event: WsServerEvent) => void;

interface TabState {
  subscriptions: string[];
  focusedDocPath: string | null;
  focusedSection: { docPath: string; headingPath: string[] } | null;
  /**
   * Stable per-tab client instance id. Used by the shared worker to filter
   * private origin-only app events (`section:edit-rejected`) so they only
   * reach the tab whose edit was rejected. Null when the tab has no per-tab
   * identity yet — private events for other tabs are dropped in that case.
   */
  clientInstanceId: string | null;
  updatedAt: number;
}

interface CrossTabTransport {
  start(onEvent: WsEventHandler): Promise<void>;
  stop(): void;
  updateTabState(state: TabState): void;
  sendClientMessage(message: WsClientMessage): void;
  subscribeWorkerDiagnostics?(): void;
  unsubscribeWorkerDiagnostics?(): void;
}

const SHARED_WORKER_HANDSHAKE_TIMEOUT_MS = 3000;

interface ForwardedDiagEntry {
  source: WsDiagSource;
  type: string;
  summary: string;
  docPath?: string;
  payload?: unknown;
}

function recordForwardedDiagEntry(entry: ForwardedDiagEntry): void {
  recordWsDiag({
    source: entry.source,
    type: entry.type,
    summary: entry.summary,
    docPath: entry.docPath,
    payload: entry.payload,
  });
}

function createTabId(): string {
  return randomUuid();
}

class SharedWorkerTransport implements CrossTabTransport {
  private readonly tabId: string;
  private workerPort: MessagePort | null = null;
  private onEvent: WsEventHandler | null = null;
  private diagnosticsSubscribed = false;
  private state: TabState = {
    subscriptions: [],
    focusedDocPath: null,
    focusedSection: null,
    clientInstanceId: null,
    updatedAt: Date.now(),
  };

  constructor(tabId: string) {
    this.tabId = tabId;
  }

  start(onEvent: WsEventHandler): Promise<void> {
    const SharedWorkerCtor = (window as Window & {
      SharedWorker?: new (url: URL, options?: { type?: "classic" | "module"; name?: string }) => SharedWorker;
    }).SharedWorker;
    if (!SharedWorkerCtor) {
      return Promise.reject(new Error("SharedWorker unavailable"));
    }
    this.onEvent = onEvent;
    let worker: SharedWorker;
    try {
      worker = new SharedWorkerCtor(
        new URL("../workers/ws-shared-worker.ts", import.meta.url),
        { type: "module", name: "ks-shared-ws" },
      );
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: number | null = null;
      const settle = (outcome: "ok" | string) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle != null) {
          window.clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (outcome === "ok") {
          resolve();
        } else {
          reject(new Error(outcome));
        }
      };

      worker.addEventListener("error", (evt) => {
        const message = (evt as ErrorEvent).message || "SharedWorker error";
        settle(`shared-worker error: ${message}`);
      });
      worker.port.addEventListener("messageerror", () => {
        settle("shared-worker messageerror");
      });
      worker.port.addEventListener("message", (message) => {
        const payload = message.data as {
          type?: string;
          event?: WsServerEvent;
          entry?: ForwardedDiagEntry;
          entries?: ForwardedDiagEntry[];
        };
        if (payload.type === "register_ack") {
          settle("ok");
          return;
        }
        if (payload.type === "server_event" && payload.event) {
          this.onEvent?.(payload.event);
          return;
        }
        if (payload.type === "diagnostics_event" && payload.entry) {
          recordForwardedDiagEntry(payload.entry);
          return;
        }
        if (payload.type === "diagnostics_backlog" && Array.isArray(payload.entries)) {
          for (const entry of payload.entries) {
            recordForwardedDiagEntry(entry);
          }
          return;
        }
      });
      worker.port.start();
      worker.port.postMessage({ type: "register", tabId: this.tabId });
      worker.port.postMessage({ type: "tab_state", tabId: this.tabId, state: this.state });
      this.workerPort = worker.port;
      timeoutHandle = window.setTimeout(() => {
        settle(`shared-worker register_ack timeout (${SHARED_WORKER_HANDSHAKE_TIMEOUT_MS}ms)`);
      }, SHARED_WORKER_HANDSHAKE_TIMEOUT_MS);
    });
  }

  stop(): void {
    if (!this.workerPort) {
      return;
    }
    if (this.diagnosticsSubscribed) {
      this.workerPort.postMessage({ type: "diagnostics:unsubscribe", tabId: this.tabId });
      this.diagnosticsSubscribed = false;
    }
    this.workerPort.postMessage({ type: "unregister", tabId: this.tabId });
    this.workerPort.close();
    this.workerPort = null;
    this.onEvent = null;
  }

  updateTabState(state: TabState): void {
    this.state = state;
    if (!this.workerPort) {
      return;
    }
    this.workerPort.postMessage({ type: "tab_state", tabId: this.tabId, state });
  }

  sendClientMessage(message: WsClientMessage): void {
    if (!this.workerPort) {
      return;
    }
    this.workerPort.postMessage({ type: "ws_send", tabId: this.tabId, message });
  }

  subscribeWorkerDiagnostics(): void {
    if (!this.workerPort || this.diagnosticsSubscribed) {
      return;
    }
    this.diagnosticsSubscribed = true;
    this.workerPort.postMessage({ type: "diagnostics:subscribe", tabId: this.tabId });
  }

  unsubscribeWorkerDiagnostics(): void {
    if (!this.workerPort || !this.diagnosticsSubscribed) {
      return;
    }
    this.diagnosticsSubscribed = false;
    this.workerPort.postMessage({ type: "diagnostics:unsubscribe", tabId: this.tabId });
  }
}

interface FallbackHeartbeatMessage {
  type: "heartbeat";
  tabId: string;
  state: TabState;
}

interface FallbackServerEventMessage {
  type: "server_event";
  tabId: string;
  event: WsServerEvent;
}

interface FallbackClientSendMessage {
  type: "client_send";
  tabId: string;
  message: WsClientMessage;
}

type FallbackChannelMessage =
  | FallbackHeartbeatMessage
  | FallbackServerEventMessage
  | FallbackClientSendMessage;

interface PeerState {
  state: TabState;
  lastSeen: number;
}

class BroadcastFallbackTransport implements CrossTabTransport {
  private readonly tabId: string;
  private channel: BroadcastChannel | null = null;
  private onEvent: WsEventHandler | null = null;
  private heartbeatTimer: number | null = null;
  private peers = new Map<string, PeerState>();
  private isLeader = false;
  private ws: WebSocket | null = null;
  private reconnectDelayMs = 1000;
  private reconnectTimer: number | null = null;
  private appliedSubscriptions = new Set<string>();
  private appliedFocusedDocPath: string | null | undefined = undefined;
  private state: TabState = {
    subscriptions: [],
    focusedDocPath: null,
    focusedSection: null,
    clientInstanceId: null,
    updatedAt: Date.now(),
  };

  constructor(tabId: string) {
    this.tabId = tabId;
  }

  async start(onEvent: WsEventHandler): Promise<void> {
    this.onEvent = onEvent;
    this.channel = new BroadcastChannel("ks-shared-ws-fallback-v1");
    this.channel.addEventListener("message", (event) => {
      const message = event.data as FallbackChannelMessage;
      if (!message || message.tabId === this.tabId) {
        return;
      }
      if (message.type === "heartbeat") {
        this.peers.set(message.tabId, {
          state: message.state,
          lastSeen: Date.now(),
        });
        this.recomputeLeader();
        return;
      }
      if (message.type === "server_event") {
        this.onEvent?.(message.event);
        return;
      }
      if (message.type === "client_send") {
        if (this.isLeader && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(message.message));
        }
      }
    });

    this.heartbeatTimer = window.setInterval(() => {
      this.tick();
    }, 1000);
    this.tick();
  }

  stop(): void {
    if (this.heartbeatTimer != null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.becomeFollower();
    this.peers.clear();
    this.onEvent = null;
  }

  updateTabState(state: TabState): void {
    this.state = state;
    this.broadcastHeartbeat();
    if (this.isLeader) {
      this.syncLeaderSessionState();
    }
  }

  sendClientMessage(message: WsClientMessage): void {
    if (this.isLeader && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    this.channel?.postMessage({
      type: "client_send",
      tabId: this.tabId,
      message,
    } satisfies FallbackClientSendMessage);
  }

  private tick(): void {
    const now = Date.now();
    for (const [tabId, peer] of this.peers.entries()) {
      if (now - peer.lastSeen > 3500) {
        this.peers.delete(tabId);
      }
    }
    this.broadcastHeartbeat();
    this.recomputeLeader();
    if (this.isLeader) {
      this.syncLeaderSessionState();
    }
  }

  private broadcastHeartbeat(): void {
    if (!this.channel) {
      return;
    }
    this.channel.postMessage({
      type: "heartbeat",
      tabId: this.tabId,
      state: this.state,
    } satisfies FallbackHeartbeatMessage);
  }

  private recomputeLeader(): void {
    const candidates = [this.tabId, ...Array.from(this.peers.keys())].sort();
    const nextLeader = candidates[0] ?? this.tabId;
    const shouldLead = nextLeader === this.tabId;
    if (shouldLead === this.isLeader) {
      return;
    }
    if (shouldLead) {
      this.becomeLeader();
      return;
    }
    this.becomeFollower();
  }

  private becomeLeader(): void {
    this.isLeader = true;
    this.connectLeaderSocket();
  }

  private becomeFollower(): void {
    this.isLeader = false;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.appliedSubscriptions = new Set<string>();
    this.appliedFocusedDocPath = undefined;
  }

  private connectLeaderSocket(): void {
    if (!this.isLeader || this.ws) {
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.ws = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelayMs = 1000;
      this.appliedSubscriptions = new Set<string>();
      this.appliedFocusedDocPath = undefined;
      this.syncLeaderSessionState();
      recordWsDiag({
        source: "ws-lifecycle",
        type: "socket_open",
        summary: `leader=${this.tabId} protocol=${protocol}`,
        payload: { tabId: this.tabId, transport: "broadcast-fallback" },
      });
    });

    socket.addEventListener("message", (raw) => {
      let serverEvent: WsServerEvent;
      try {
        serverEvent = JSON.parse(String(raw.data)) as WsServerEvent;
      } catch {
        // Ignore malformed transport payloads.
        return;
      }
      this.onEvent?.(serverEvent);
      this.channel?.postMessage({
        type: "server_event",
        tabId: this.tabId,
        event: serverEvent,
      } satisfies FallbackServerEventMessage);
    });

    socket.addEventListener("close", (event) => {
      if (this.ws === socket) {
        this.ws = null;
      }
      recordWsDiag({
        source: "ws-lifecycle",
        type: "socket_close",
        summary: `code=${event.code} reason=${event.reason || "(none)"}`,
        payload: { tabId: this.tabId, code: event.code, reason: event.reason, wasClean: event.wasClean, transport: "broadcast-fallback" },
      });
      if (!this.isLeader) {
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null || !this.isLeader) {
      return;
    }
    const delay = this.reconnectDelayMs;
    recordWsDiag({
      source: "ws-lifecycle",
      type: "reconnect_scheduled",
      summary: `in ${delay}ms`,
      payload: { tabId: this.tabId, delayMs: delay, transport: "broadcast-fallback" },
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectLeaderSocket();
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15000);
  }

  private aggregateDesiredState(): {
    subscriptions: Set<string>;
    focusedDocPath: string | null;
    focusedSection: { docPath: string; headingPath: string[] } | null;
  } {
    const states: TabState[] = [this.state];
    for (const peer of this.peers.values()) {
      states.push(peer.state);
    }

    const subscriptions = new Set<string>();
    for (const state of states) {
      for (const path of state.subscriptions) {
        subscriptions.add(path);
      }
    }

    const mostRecentFocus = states
      .filter((state) => typeof state.focusedDocPath === "string" && state.focusedDocPath.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    return {
      subscriptions,
      focusedDocPath: mostRecentFocus?.focusedDocPath ?? null,
      focusedSection: mostRecentFocus?.focusedSection ?? null,
    };
  }

  private syncLeaderSessionState(): void {
    if (!this.isLeader || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const desired = this.aggregateDesiredState();

    for (const path of desired.subscriptions) {
      if (!this.appliedSubscriptions.has(path)) {
        this.ws.send(JSON.stringify({ subscribe: path }));
      }
    }
    for (const path of this.appliedSubscriptions) {
      if (!desired.subscriptions.has(path)) {
        this.ws.send(JSON.stringify({ unsubscribe: path }));
      }
    }
    this.appliedSubscriptions = desired.subscriptions;

    // Document-level focus/blur is the only retained focus signal on the JSON
    // application socket. The former section_focus/section_blur frames were
    // removed (MW-13): the hub never consumed them (spec 06 §6).
    if (this.appliedFocusedDocPath !== desired.focusedDocPath) {
      if (desired.focusedDocPath) {
        this.ws.send(
          JSON.stringify({
            type: "document_focus",
            doc_path: desired.focusedDocPath,
          }),
        );
      } else {
        this.ws.send(JSON.stringify({ type: "document_blur" }));
      }
      this.appliedFocusedDocPath = desired.focusedDocPath;
    }
  }
}

/** Steady-state transport for the JSON app WebSocket (`/ws`). */
export type AppWsTransportKind = "shared-worker" | "broadcast-fallback";

export interface AppWsTransportInfo {
  /** Null while no session is held, or before the first transport settles. */
  kind: AppWsTransportKind | null;
  /** Present only after SharedWorker failed and broadcast fallback was chosen. */
  fallbackReason: string | null;
}

class SessionWsManager {
  private readonly tabId = createTabId();
  private transport: CrossTabTransport | null = null;
  private started = false;
  private referenceCount = 0;
  private listeners = new Set<WsEventHandler>();
  private localSubscriptionRefCounts = new Map<string, number>();
  private focusedDocPath: string | null = null;
  private focusedSection: { docPath: string; headingPath: string[] } | null = null;
  private heartbeatTimer: number | null = null;
  private fallbackTransitioned = false;
  private clientInstanceId: string | null = null;
  private transportSnapshot: AppWsTransportInfo = { kind: null, fallbackReason: null };
  private readonly transportListeners = new Set<() => void>();

  addListener(handler: WsEventHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  getTransportInfo(): AppWsTransportInfo {
    // Stable reference until kind/reason change — required by useSyncExternalStore.
    return this.transportSnapshot;
  }

  subscribeTransport(listener: () => void): () => void {
    this.transportListeners.add(listener);
    return () => {
      this.transportListeners.delete(listener);
    };
  }

  private setTransportInfo(kind: AppWsTransportKind | null, fallbackReason: string | null): void {
    if (
      this.transportSnapshot.kind === kind &&
      this.transportSnapshot.fallbackReason === fallbackReason
    ) {
      return;
    }
    this.transportSnapshot = { kind, fallbackReason };
    for (const listener of this.transportListeners) {
      listener();
    }
  }

  acquire(): void {
    this.referenceCount += 1;
    if (this.started) {
      return;
    }
    this.started = true;
    this.fallbackTransitioned = false;
    this.setTransportInfo(null, null);

    recordWsDiag({
      source: "ws-lifecycle",
      type: "session_attempting",
      summary: `transport=shared-worker tabId=${this.tabId}`,
      payload: { tabId: this.tabId, transport: "shared-worker" },
    });

    const attempted = new SharedWorkerTransport(this.tabId);
    this.transport = attempted;
    attempted
      .start((event) => this.handleIncomingEvent(event))
      .then(() => {
        if (this.transport !== attempted || !this.started) {
          return;
        }
        this.setTransportInfo("shared-worker", null);
        recordWsDiag({
          source: "ws-lifecycle",
          type: "session_acquired",
          summary: `transport=shared-worker tabId=${this.tabId}`,
          payload: { tabId: this.tabId, transport: "shared-worker" },
        });
        this.pushTabState();
      })
      .catch((err: unknown) => {
        if (this.transport !== attempted || !this.started) {
          return;
        }
        const reason = err instanceof Error ? err.message : String(err);
        this.fallbackToBroadcastTransport(reason);
      });

    this.heartbeatTimer = window.setInterval(() => {
      this.pushTabState();
    }, 1500);
    this.pushTabState();
  }

  private fallbackToBroadcastTransport(reason: string): void {
    if (this.fallbackTransitioned || !this.started) {
      return;
    }
    this.fallbackTransitioned = true;

    recordWsDiag({
      source: "ws-lifecycle",
      type: "transport_failed",
      summary: `transport=shared-worker reason=${reason}`,
      payload: { tabId: this.tabId, transport: "shared-worker", reason },
    });

    const failed = this.transport;
    this.transport = null;
    failed?.stop();

    recordWsDiag({
      source: "ws-lifecycle",
      type: "session_attempting",
      summary: `transport=broadcast-fallback tabId=${this.tabId}`,
      payload: { tabId: this.tabId, transport: "broadcast-fallback" },
    });

    const fallback = new BroadcastFallbackTransport(this.tabId);
    this.transport = fallback;
    // Surface the degraded mode as soon as we abandon SharedWorker — do not wait
    // for the fallback socket to finish opening (that can stall indefinitely).
    this.setTransportInfo("broadcast-fallback", reason);
    fallback
      .start((event) => this.handleIncomingEvent(event))
      .then(() => {
        if (this.transport !== fallback || !this.started) {
          return;
        }
        recordWsDiag({
          source: "ws-lifecycle",
          type: "session_acquired",
          summary: `transport=broadcast-fallback tabId=${this.tabId}`,
          payload: { tabId: this.tabId, transport: "broadcast-fallback" },
        });
        this.pushTabState();
      })
      .catch((err: unknown) => {
        const fallbackReason = err instanceof Error ? err.message : String(err);
        recordWsDiag({
          source: "ws-lifecycle",
          type: "transport_failed",
          summary: `transport=broadcast-fallback reason=${fallbackReason}`,
          payload: {
            tabId: this.tabId,
            transport: "broadcast-fallback",
            reason: fallbackReason,
          },
        });
      });
  }

  release(): void {
    this.referenceCount = Math.max(0, this.referenceCount - 1);
    if (this.referenceCount > 0 || !this.started) {
      return;
    }
    this.started = false;
    if (this.heartbeatTimer != null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.transport?.stop();
    this.transport = null;
    this.setTransportInfo(null, null);
    recordWsDiag({
      source: "ws-lifecycle",
      type: "session_released",
      summary: `tabId=${this.tabId}`,
      payload: { tabId: this.tabId },
    });
  }

  subscribe(docPath: string, clientInstanceId?: string): void {
    const normalized = docPath.trim();
    if (!normalized) {
      return;
    }
    if (clientInstanceId) this.clientInstanceId = clientInstanceId;
    const previous = this.localSubscriptionRefCounts.get(normalized) ?? 0;
    this.localSubscriptionRefCounts.set(normalized, previous + 1);
    this.pushTabState();
  }

  unsubscribe(docPath: string): void {
    const normalized = docPath.trim();
    if (!normalized) {
      return;
    }
    const previous = this.localSubscriptionRefCounts.get(normalized) ?? 0;
    if (previous <= 1) {
      this.localSubscriptionRefCounts.delete(normalized);
    } else {
      this.localSubscriptionRefCounts.set(normalized, previous - 1);
    }
    this.pushTabState();
  }

  focusDocument(docPath: string): void {
    const normalized = docPath.trim();
    if (!normalized) {
      return;
    }
    this.focusedDocPath = normalized;
    this.focusedSection = null;
    this.pushTabState();
  }

  blurDocument(docPath?: string): void {
    if (docPath && this.focusedDocPath && this.focusedDocPath !== docPath) {
      return;
    }
    this.focusedDocPath = null;
    this.focusedSection = null;
    this.pushTabState();
  }

  private pushTabState(): void {
    if (!this.started || !this.transport) {
      return;
    }
    this.transport.updateTabState({
      subscriptions: Array.from(this.localSubscriptionRefCounts.keys()),
      focusedDocPath: this.focusedDocPath,
      focusedSection: this.focusedSection,
      clientInstanceId: this.clientInstanceId,
      updatedAt: Date.now(),
    });
  }

  private handleIncomingEvent(event: WsServerEvent): void {
    const eventRecord = event as unknown as Record<string, unknown>;
    const type = typeof eventRecord.type === "string" ? eventRecord.type : "(untyped)";
    const docPath = typeof eventRecord.doc_path === "string" ? eventRecord.doc_path : undefined;
    recordWsDiag({
      source: "ws-frame",
      type,
      summary: docPath ? `doc=${docPath}` : "",
      docPath,
      payload: event,
    });
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        queueMicrotask(() => { throw err; });
      }
    }
  }

  sendClientMessage(message: WsClientMessage): void {
    if (!this.started || !this.transport) {
      return;
    }
    this.transport.sendClientMessage(message);
  }

  subscribeWorkerDiagnostics(): void {
    this.transport?.subscribeWorkerDiagnostics?.();
  }

  unsubscribeWorkerDiagnostics(): void {
    this.transport?.unsubscribeWorkerDiagnostics?.();
  }

  resetForTests(): void {
    if (this.heartbeatTimer != null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.transport?.stop();
    this.transport = null;
    this.started = false;
    this.referenceCount = 0;
    this.fallbackTransitioned = false;
    this.listeners.clear();
    this.localSubscriptionRefCounts.clear();
    this.focusedDocPath = null;
    this.focusedSection = null;
    this.setTransportInfo(null, null);
    this.transportListeners.clear();
  }
}

let sessionWsManager: SessionWsManager | null = null;

function getSessionWsManager(): SessionWsManager {
  if (!sessionWsManager) {
    sessionWsManager = new SessionWsManager();
  }
  return sessionWsManager;
}

export function subscribeWorkerDiagnostics(): void {
  getSessionWsManager().subscribeWorkerDiagnostics();
}

export function unsubscribeWorkerDiagnostics(): void {
  getSessionWsManager().unsubscribeWorkerDiagnostics();
}

/** Current JSON-app-WS transport (SharedWorker vs BroadcastChannel fallback). */
export function getAppWsTransportInfo(): AppWsTransportInfo {
  return getSessionWsManager().getTransportInfo();
}

/** Subscribe to transport-mode changes (for footer / diagnostics UI). */
export function subscribeAppWsTransport(listener: () => void): () => void {
  return getSessionWsManager().subscribeTransport(listener);
}

/**
 * Human-readable explanation of why SharedWorker was abandoned. Kept next to
 * the handshake failure strings so the footer tooltip stays aligned with the
 * real reject reasons in {@link SharedWorkerTransport.start}.
 */
export function describeAppWsBroadcastFallback(reason: string | null): string {
  const detail = (() => {
    if (!reason) {
      return "The SharedWorker handshake failed for an unknown reason.";
    }
    if (reason === "SharedWorker unavailable") {
      return "This browser does not expose SharedWorker (unsupported, disabled, or blocked).";
    }
    if (reason.startsWith("shared-worker error:")) {
      return "The SharedWorker script failed to load or crashed while starting.";
    }
    if (reason === "shared-worker messageerror") {
      return "The SharedWorker could not exchange messages with this tab.";
    }
    if (reason.includes("register_ack timeout")) {
      return "The SharedWorker never acknowledged this tab (handshake timed out).";
    }
    return `SharedWorker failed to start (${reason}).`;
  })();
  return (
    `${detail} Civigent fell back to a backup: a WebSocket owned by this tab, ` +
    `coordinated across tabs with BroadcastChannel. Live updates still work, but ` +
    `this tab can be frozen by the browser when you switch away, which briefly ` +
    `drops the connection and shows “reconnecting”. Reload the page after fixing ` +
    `the browser/worker issue to restore the SharedWorker path.`
  );
}

/**
 * Test-only escape hatch to clear singleton session state between specs.
 * This keeps production behavior unchanged while avoiding cross-test leakage.
 */
export function __resetSessionWsManagerForTests(): void {
  if (!sessionWsManager) {
    return;
  }
  sessionWsManager.resetForTests();
  sessionWsManager = null;
}

export class KnowledgeStoreWsClient {
  private readonly manager = getSessionWsManager();
  private removeListener: (() => void) | null = null;

  connect(): void {
    this.manager.acquire();
  }

  onEvent(handler: WsEventHandler): void {
    if (this.removeListener) {
      this.removeListener();
    }
    this.removeListener = this.manager.addListener(handler);
  }

  /**
   * Subscribe to a document. When a stable per-tab `clientInstanceId` is
   * supplied, it is bound to this tab's shared-worker/hub state so private
   * origin-only app events (`section:edit-rejected`) route only to this tab.
   * Ordinary broadcast events continue to be delivered regardless of the id.
   */
  subscribe(docPath: string, clientInstanceId?: string): void {
    this.manager.subscribe(docPath, clientInstanceId);
  }

  unsubscribe(docPath: string): void {
    this.manager.unsubscribe(docPath);
  }

  focusDocument(docPath: string): void {
    this.manager.focusDocument(docPath);
  }

  blurDocument(docPath?: string): void {
    this.manager.blurDocument(docPath);
  }

  disconnect(): void {
    if (this.removeListener) {
      this.removeListener();
      this.removeListener = null;
    }
    this.manager.release();
  }
}
