import { WorkerDiagnostics } from "./ws-shared-worker-diagnostics";
import {
  isPrivateEnvelope,
  selectPrivateEnvelopeTarget,
  type PrivateEnvelope,
} from "./ws-shared-worker-routing";

interface TabState {
  subscriptions: string[];
  focusedDocPath: string | null;
  focusedSection: { docPath: string; headingPath: string[] } | null;
  /**
   * Stable per-tab client instance id. When a private envelope arrives from the
   * server (`{ __private__: true, target_client_instance_id }`), the worker
   * forwards the inner event ONLY to the tab whose `clientInstanceId` matches.
   * Ordinary broadcast events ignore this field.
   */
  clientInstanceId: string | null;
  updatedAt: number;
}

interface RegisterMessage {
  type: "register";
  tabId: string;
}

interface UnregisterMessage {
  type: "unregister";
  tabId: string;
}

interface TabStateMessage {
  type: "tab_state";
  tabId: string;
  state: TabState;
}

interface WsSendMessage {
  type: "ws_send";
  tabId: string;
  message: unknown;
}

interface DiagnosticsSubscribeMessage {
  type: "diagnostics:subscribe";
  tabId: string;
}

interface DiagnosticsUnsubscribeMessage {
  type: "diagnostics:unsubscribe";
  tabId: string;
}

type WorkerInboundMessage =
  | RegisterMessage
  | UnregisterMessage
  | TabStateMessage
  | WsSendMessage
  | DiagnosticsSubscribeMessage
  | DiagnosticsUnsubscribeMessage;

const workerScope = self as unknown as {
  location: Location;
  onconnect: ((event: MessageEvent) => void) | null;
};

const tabPorts = new Map<string, MessagePort>();
const tabStates = new Map<string, TabState>();
const diagnostics = new WorkerDiagnostics();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1000;
let appliedSubscriptions = new Set<string>();
let appliedFocusedDocPath: string | null | undefined = undefined;

const SYSTEM_ES_INITIAL_RETRY_MS = 1000;
const SYSTEM_ES_MAX_RETRY_MS = 10000;

let systemEventSource: EventSource | null = null;
let systemEsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let systemEsRetryMs = SYSTEM_ES_INITIAL_RETRY_MS;
let lastSystemState: unknown = null;

function broadcastServerEvent(event: unknown): void {
  for (const port of tabPorts.values()) {
    port.postMessage({ type: "server_event", event });
  }
}

function broadcastSystemState(state: unknown): void {
  for (const port of tabPorts.values()) {
    port.postMessage({ type: "system_state", state });
  }
}

function ensureSystemEventSource(): void {
  if (!import.meta.env.DEV) return;
  if (systemEventSource || tabPorts.size === 0) return;
  const es = new EventSource("/api/system/events");
  systemEventSource = es;

  es.addEventListener("system_state", (e) => {
    systemEsRetryMs = SYSTEM_ES_INITIAL_RETRY_MS;
    const state: unknown = JSON.parse((e as MessageEvent).data);
    lastSystemState = state;
    broadcastSystemState(state);
  });

  es.addEventListener("error", () => {
    if (systemEventSource === es && es.readyState === EventSource.CLOSED) {
      es.close();
      systemEventSource = null;
      scheduleSystemEsRetry();
    }
  });
}

function scheduleSystemEsRetry(): void {
  if (systemEsRetryTimer || tabPorts.size === 0) return;
  systemEsRetryTimer = setTimeout(() => {
    systemEsRetryTimer = null;
    ensureSystemEventSource();
  }, systemEsRetryMs);
  systemEsRetryMs = Math.min(systemEsRetryMs * 2, SYSTEM_ES_MAX_RETRY_MS);
}

function closeSystemEventSource(): void {
  if (systemEsRetryTimer) {
    clearTimeout(systemEsRetryTimer);
    systemEsRetryTimer = null;
  }
  if (systemEventSource) {
    systemEventSource.close();
    systemEventSource = null;
  }
  systemEsRetryMs = SYSTEM_ES_INITIAL_RETRY_MS;
}

function forwardPrivateEnvelope(envelope: PrivateEnvelope): void {
  const targetTabId = selectPrivateEnvelopeTarget(envelope, tabStates.entries());
  if (targetTabId === null) return;
  const port = tabPorts.get(targetTabId);
  if (!port) return;
  port.postMessage({ type: "server_event", event: envelope.event });
}

function describeOutgoing(obj: unknown): { type: string; docPath: string | undefined } {
  if (!obj || typeof obj !== "object") {
    return { type: "(untyped)", docPath: undefined };
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.type === "string") {
    const docPath = typeof rec.doc_path === "string" ? rec.doc_path : undefined;
    return { type: rec.type, docPath };
  }
  if (typeof rec.subscribe === "string") {
    return { type: "subscribe", docPath: rec.subscribe };
  }
  if (typeof rec.unsubscribe === "string") {
    return { type: "unsubscribe", docPath: rec.unsubscribe };
  }
  return { type: "(untyped)", docPath: undefined };
}

function sendWs(obj: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(obj));
  const { type, docPath } = describeOutgoing(obj);
  diagnostics.capture({
    source: "worker-outgoing",
    type,
    summary: docPath ? `doc=${docPath}` : "",
    docPath,
    payload: obj,
  });
}

function desiredSessionState(): {
  subscriptions: Set<string>;
  focusedDocPath: string | null;
  focusedSection: { docPath: string; headingPath: string[] } | null;
} {
  const states = Array.from(tabStates.values());
  const subscriptions = new Set<string>();
  for (const state of states) {
    for (const path of state.subscriptions) {
      subscriptions.add(path);
    }
  }
  const latestFocus = states
    .filter((state) => typeof state.focusedDocPath === "string" && state.focusedDocPath.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return {
    subscriptions,
    focusedDocPath: latestFocus?.focusedDocPath ?? null,
    focusedSection: latestFocus?.focusedSection ?? null,
  };
}

function ensureSocket(): void {
  if (ws || tabPorts.size === 0) {
    return;
  }
  const protocol = workerScope.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${workerScope.location.host}/ws`);
  ws = socket;

  socket.addEventListener("open", () => {
    reconnectDelayMs = 1000;
    appliedSubscriptions = new Set<string>();
    appliedFocusedDocPath = undefined;
    diagnostics.capture({
      source: "worker-lifecycle",
      type: "open",
      summary: `${protocol}://${workerScope.location.host}/ws`,
      payload: { tabs: tabPorts.size },
    });
    syncSocketState();
  });

  socket.addEventListener("message", (raw) => {
    const rawData = String(raw.data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      diagnostics.capture({
        source: "worker-incoming",
        type: "(malformed)",
        summary: `len=${rawData.length}`,
        payload: rawData,
      });
      return;
    }
    if (isPrivateEnvelope(parsed)) {
      const inner = parsed.event as Record<string, unknown> | null | undefined;
      const type = typeof inner?.type === "string" ? inner.type : "(untyped)";
      const docPath = typeof inner?.doc_path === "string" ? (inner.doc_path as string) : undefined;
      diagnostics.capture({
        source: "worker-incoming",
        type: `private:${type}`,
        summary: docPath ? `doc=${docPath} target=${parsed.target_client_instance_id}` : `target=${parsed.target_client_instance_id}`,
        docPath,
        payload: parsed,
      });
      forwardPrivateEnvelope(parsed);
      return;
    }
    const serverEvent = parsed;
    const eventRec = serverEvent as Record<string, unknown>;
    const type = typeof eventRec.type === "string" ? eventRec.type : "(untyped)";
    const docPath = typeof eventRec.doc_path === "string" ? eventRec.doc_path : undefined;
    diagnostics.capture({
      source: "worker-incoming",
      type,
      summary: docPath ? `doc=${docPath}` : "",
      docPath,
      payload: serverEvent,
    });
    broadcastServerEvent(serverEvent);
  });

  socket.addEventListener("close", (event) => {
    if (ws === socket) {
      ws = null;
    }
    diagnostics.capture({
      source: "worker-lifecycle",
      type: "close",
      summary: `code=${event.code} reason=${event.reason || "(none)"}`,
      payload: { code: event.code, reason: event.reason, wasClean: event.wasClean },
    });
    if (tabPorts.size === 0) {
      return;
    }
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    diagnostics.capture({
      source: "worker-lifecycle",
      type: "error",
      summary: "socket error",
    });
    socket.close();
  });
}

function closeSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  appliedSubscriptions = new Set<string>();
  appliedFocusedDocPath = undefined;
}

function scheduleReconnect(): void {
  if (reconnectTimer || tabPorts.size === 0) {
    return;
  }
  const delay = reconnectDelayMs;
  diagnostics.capture({
    source: "worker-lifecycle",
    type: "reconnect_scheduled",
    summary: `in ${delay}ms`,
    payload: { delayMs: delay },
  });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, delay);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
}

function syncSocketState(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  const desired = desiredSessionState();
  for (const path of desired.subscriptions) {
    if (!appliedSubscriptions.has(path)) {
      sendWs({ subscribe: path });
    }
  }
  for (const path of appliedSubscriptions) {
    if (!desired.subscriptions.has(path)) {
      sendWs({ unsubscribe: path });
    }
  }
  appliedSubscriptions = desired.subscriptions;

  // Document-level focus/blur is the only retained focus signal (MW-13): the
  // hub never consumed section_focus/section_blur (spec 06 §6).
  if (appliedFocusedDocPath !== desired.focusedDocPath) {
    if (desired.focusedDocPath) {
      sendWs({
        type: "document_focus",
        doc_path: desired.focusedDocPath,
      });
    } else {
      sendWs({ type: "document_blur" });
    }
    appliedFocusedDocPath = desired.focusedDocPath;
  }
}

function sweepStaleTabs(): void {
  const now = Date.now();
  let changed = false;
  for (const [tabId, state] of tabStates.entries()) {
    if (now - state.updatedAt > 7000) {
      const port = tabPorts.get(tabId);
      if (port) {
        diagnostics.unsubscribe(port);
      }
      tabStates.delete(tabId);
      tabPorts.delete(tabId);
      changed = true;
    }
  }
  if (changed) {
    if (tabPorts.size === 0) {
      closeSocket();
      closeSystemEventSource();
    } else {
      syncSocketState();
    }
  }
}

setInterval(() => {
  sweepStaleTabs();
  if (tabPorts.size > 0 && !ws) {
    ensureSocket();
  }
  if (tabPorts.size > 0 && !systemEventSource && !systemEsRetryTimer) {
    ensureSystemEventSource();
  }
}, 2000);

workerScope.onconnect = (connectEvent) => {
  const ports = (connectEvent as unknown as { ports: MessagePort[] }).ports;
  const port = ports[0];
  if (!port) {
    return;
  }
  port.start();
  port.addEventListener("message", (messageEvent) => {
    const message = messageEvent.data as WorkerInboundMessage;
    if (!message || typeof message !== "object" || !("type" in message)) {
      return;
    }
    if (message.type === "register") {
      tabPorts.set(message.tabId, port);
      tabStates.set(message.tabId, {
        subscriptions: [],
        focusedDocPath: null,
        focusedSection: null,
        clientInstanceId: null,
        updatedAt: Date.now(),
      });
      port.postMessage({ type: "register_ack", tabId: message.tabId });
      if (lastSystemState !== null) {
        port.postMessage({ type: "system_state", state: lastSystemState });
      }
      ensureSocket();
      ensureSystemEventSource();
      syncSocketState();
      return;
    }
    if (message.type === "tab_state") {
      tabPorts.set(message.tabId, port);
      const priorTabState = tabStates.get(message.tabId);
      const priorInstanceId = priorTabState?.clientInstanceId ?? null;
      const nextInstanceId =
        typeof message.state.clientInstanceId === "string" && message.state.clientInstanceId.length > 0
          ? message.state.clientInstanceId
          : priorInstanceId;
      const nextSubscriptions = Array.isArray(message.state.subscriptions) ? message.state.subscriptions : [];
      tabStates.set(message.tabId, {
        subscriptions: nextSubscriptions,
        focusedDocPath: message.state.focusedDocPath ?? null,
        focusedSection: message.state.focusedSection ?? null,
        clientInstanceId: nextInstanceId,
        updatedAt: Date.now(),
      });
      if (ws && ws.readyState === WebSocket.OPEN) {
        const priorTabSubscriptions = new Set(priorTabState?.subscriptions ?? []);
        for (const path of nextSubscriptions) {
          if (!priorTabSubscriptions.has(path) && appliedSubscriptions.has(path)) {
            sendWs({ subscribe: path });
          }
        }
      }
      // Forward the client-instance id to the hub via an `identify` message so
      // the backend's private routing knows to target this leader socket for
      // the given clientInstanceId. Only sent when the id changes to avoid
      // per-tick chatter.
      if (nextInstanceId && nextInstanceId !== priorInstanceId) {
        sendWs({ action: "identify", clientInstanceId: nextInstanceId });
      }
      ensureSocket();
      syncSocketState();
      return;
    }
    if (message.type === "unregister") {
      const existingPort = tabPorts.get(message.tabId);
      if (existingPort) {
        diagnostics.unsubscribe(existingPort);
      }
      tabPorts.delete(message.tabId);
      tabStates.delete(message.tabId);
      if (tabPorts.size === 0) {
        closeSocket();
        closeSystemEventSource();
      } else {
        syncSocketState();
      }
      return;
    }
    if (message.type === "ws_send") {
      sendWs(message.message);
      return;
    }
    if (message.type === "diagnostics:subscribe") {
      diagnostics.subscribe(port);
      return;
    }
    if (message.type === "diagnostics:unsubscribe") {
      diagnostics.unsubscribe(port);
      return;
    }
  });
};
