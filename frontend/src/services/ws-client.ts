import type { WsClientMessage, WsServerEvent } from "../types/shared.js";
import { randomUuid } from "../utils/random-uuid";
import { recordWsDiag } from "./ws-diagnostics";

export type WsEventHandler = (event: WsServerEvent) => void;

interface TabState {
  subscriptions: string[];
  focusedDocPath: string | null;
  focusedSection: { docPath: string; headingPath: string[] } | null;
  updatedAt: number;
}

interface CrossTabTransport {
  start(onEvent: WsEventHandler): void;
  stop(): void;
  updateTabState(state: TabState): void;
  sendClientMessage(message: WsClientMessage): void;
}

function createTabId(): string {
  return randomUuid();
}

class SharedWorkerTransport implements CrossTabTransport {
  private readonly tabId: string;
  private workerPort: MessagePort | null = null;
  private onEvent: WsEventHandler | null = null;
  private state: TabState = {
    subscriptions: [],
    focusedDocPath: null,
    focusedSection: null,
    updatedAt: Date.now(),
  };

  constructor(tabId: string) {
    this.tabId = tabId;
  }

  start(onEvent: WsEventHandler): void {
    const SharedWorkerCtor = (window as Window & {
      SharedWorker?: new (url: URL, options?: { type?: "classic" | "module"; name?: string }) => SharedWorker;
    }).SharedWorker;
    if (!SharedWorkerCtor) {
      throw new Error("SharedWorker unavailable");
    }
    this.onEvent = onEvent;
    const worker = new SharedWorkerCtor(
      new URL("../workers/ws-shared-worker.ts", import.meta.url),
      { type: "module", name: "ks-shared-ws" },
    );
    worker.port.start();
    worker.port.addEventListener("message", (message) => {
      const payload = message.data as { type?: string; event?: WsServerEvent };
      if (payload.type === "server_event" && payload.event) {
        this.onEvent?.(payload.event);
      }
    });
    worker.port.postMessage({ type: "register", tabId: this.tabId });
    worker.port.postMessage({ type: "tab_state", tabId: this.tabId, state: this.state });
    this.workerPort = worker.port;
  }

  stop(): void {
    if (!this.workerPort) {
      return;
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
  private appliedFocusedSection: { docPath: string; headingPath: string[] } | null | undefined = undefined;
  private state: TabState = {
    subscriptions: [],
    focusedDocPath: null,
    focusedSection: null,
    updatedAt: Date.now(),
  };

  constructor(tabId: string) {
    this.tabId = tabId;
  }

  start(onEvent: WsEventHandler): void {
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
    this.appliedFocusedSection = undefined;
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
      this.appliedFocusedSection = undefined;
      this.syncLeaderSessionState();
      recordWsDiag({
        source: "ws-lifecycle",
        type: "socket_open",
        summary: `leader=${this.tabId} protocol=${protocol}`,
        payload: { tabId: this.tabId, transport: "broadcast-fallback" },
      });
    });

    socket.addEventListener("message", (raw) => {
      try {
        const serverEvent = JSON.parse(String(raw.data)) as WsServerEvent;
        this.onEvent?.(serverEvent);
        this.channel?.postMessage({
          type: "server_event",
          tabId: this.tabId,
          event: serverEvent,
        } satisfies FallbackServerEventMessage);
      } catch {
        // Ignore malformed transport payloads.
      }
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

    const appliedSectionKey = this.appliedFocusedSection
      ? `${this.appliedFocusedSection.docPath}\u001f${this.appliedFocusedSection.headingPath.join("\u001f")}`
      : null;
    const desiredSectionKey = desired.focusedSection
      ? `${desired.focusedSection.docPath}\u001f${desired.focusedSection.headingPath.join("\u001f")}`
      : null;

    if (appliedSectionKey !== desiredSectionKey) {
      if (desired.focusedSection) {
        this.ws.send(
          JSON.stringify({
            type: "section_focus",
            doc_path: desired.focusedSection.docPath,
            heading_path: desired.focusedSection.headingPath,
          }),
        );
      } else if (this.appliedFocusedSection) {
        this.ws.send(
          JSON.stringify({
            type: "section_blur",
            doc_path: this.appliedFocusedSection.docPath,
            heading_path: this.appliedFocusedSection.headingPath,
          }),
        );
      }
      this.appliedFocusedSection = desired.focusedSection;
    }

    if (!desired.focusedSection && this.appliedFocusedDocPath !== desired.focusedDocPath) {
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
    } else if (desired.focusedSection) {
      this.appliedFocusedDocPath = desired.focusedDocPath;
    }
  }
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

  addListener(handler: WsEventHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  acquire(): void {
    this.referenceCount += 1;
    if (this.started) {
      return;
    }
    this.started = true;
    let transportKind: "shared-worker" | "broadcast-fallback";
    try {
      this.transport = new SharedWorkerTransport(this.tabId);
      this.transport.start((event) => this.handleIncomingEvent(event));
      transportKind = "shared-worker";
    } catch {
      this.transport = new BroadcastFallbackTransport(this.tabId);
      this.transport.start((event) => this.handleIncomingEvent(event));
      transportKind = "broadcast-fallback";
    }
    recordWsDiag({
      source: "ws-lifecycle",
      type: "session_acquired",
      summary: `transport=${transportKind} tabId=${this.tabId}`,
      payload: { tabId: this.tabId, transport: transportKind },
    });
    this.heartbeatTimer = window.setInterval(() => {
      this.pushTabState();
    }, 1500);
    this.pushTabState();
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
    recordWsDiag({
      source: "ws-lifecycle",
      type: "session_released",
      summary: `tabId=${this.tabId}`,
      payload: { tabId: this.tabId },
    });
  }

  subscribe(docPath: string): void {
    const normalized = docPath.trim();
    if (!normalized) {
      return;
    }
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

  focusSection(docPath: string, headingPath: string[]): void {
    const normalizedDoc = docPath.trim();
    const normalizedHeading = headingPath.map((segment) => segment.trim()).filter(Boolean);
    if (!normalizedDoc || normalizedHeading.length === 0) {
      return;
    }
    this.focusedDocPath = normalizedDoc;
    this.focusedSection = {
      docPath: normalizedDoc,
      headingPath: normalizedHeading,
    };
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

  blurSection(docPath: string, headingPath: string[]): void {
    const normalizedDoc = docPath.trim();
    const normalizedHeading = headingPath.map((segment) => segment.trim()).filter(Boolean);
    if (!normalizedDoc || normalizedHeading.length === 0) {
      return;
    }
    if (
      !this.focusedSection
      || this.focusedSection.docPath !== normalizedDoc
      || JSON.stringify(this.focusedSection.headingPath) !== JSON.stringify(normalizedHeading)
    ) {
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
      listener(event);
    }
  }

  sendClientMessage(message: WsClientMessage): void {
    if (!this.started || !this.transport) {
      return;
    }
    this.transport.sendClientMessage(message);
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
    this.listeners.clear();
    this.localSubscriptionRefCounts.clear();
    this.focusedDocPath = null;
    this.focusedSection = null;
  }
}

let sessionWsManager: SessionWsManager | null = null;

function getSessionWsManager(): SessionWsManager {
  if (!sessionWsManager) {
    sessionWsManager = new SessionWsManager();
  }
  return sessionWsManager;
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

  subscribe(docPath: string): void {
    this.manager.subscribe(docPath);
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

  focusSection(docPath: string, headingPath: string[]): void {
    this.manager.focusSection(docPath, headingPath);
  }

  blurSection(docPath: string, headingPath: string[]): void {
    this.manager.blurSection(docPath, headingPath);
  }

  sessionDeparture(docPath: string): void {
    this.manager.sendClientMessage({
      action: "session_departure",
      doc_path: docPath,
    });
  }

  disconnect(): void {
    if (this.removeListener) {
      this.removeListener();
      this.removeListener = null;
    }
    this.manager.release();
  }
}
