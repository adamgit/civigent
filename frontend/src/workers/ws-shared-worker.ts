import { WorkerDiagnostics } from "./ws-shared-worker-diagnostics";

interface TabState {
  subscriptions: string[];
  focusedDocPath: string | null;
  focusedSection: { docPath: string; headingPath: string[] } | null;
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
let appliedFocusedSection: { docPath: string; headingPath: string[] } | null | undefined = undefined;

function broadcastServerEvent(event: unknown): void {
  for (const port of tabPorts.values()) {
    port.postMessage({ type: "server_event", event });
  }
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
    appliedFocusedSection = undefined;
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
    try {
      const serverEvent = JSON.parse(rawData);
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
    } catch {
      diagnostics.capture({
        source: "worker-incoming",
        type: "(malformed)",
        summary: `len=${rawData.length}`,
        payload: rawData,
      });
    }
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
  appliedFocusedSection = undefined;
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

  const appliedSectionKey = appliedFocusedSection
    ? `${appliedFocusedSection.docPath}\u001f${appliedFocusedSection.headingPath.join("\u001f")}`
    : null;
  const desiredSectionKey = desired.focusedSection
    ? `${desired.focusedSection.docPath}\u001f${desired.focusedSection.headingPath.join("\u001f")}`
    : null;
  if (appliedSectionKey !== desiredSectionKey) {
    if (desired.focusedSection) {
      sendWs({
        type: "section_focus",
        doc_path: desired.focusedSection.docPath,
        heading_path: desired.focusedSection.headingPath,
      });
    } else if (appliedFocusedSection) {
      sendWs({
        type: "section_blur",
        doc_path: appliedFocusedSection.docPath,
        heading_path: appliedFocusedSection.headingPath,
      });
    }
    appliedFocusedSection = desired.focusedSection;
  }

  if (!desired.focusedSection && appliedFocusedDocPath !== desired.focusedDocPath) {
    if (desired.focusedDocPath) {
      sendWs({
        type: "document_focus",
        doc_path: desired.focusedDocPath,
      });
    } else {
      sendWs({ type: "document_blur" });
    }
    appliedFocusedDocPath = desired.focusedDocPath;
  } else if (desired.focusedSection) {
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
        updatedAt: Date.now(),
      });
      ensureSocket();
      syncSocketState();
      return;
    }
    if (message.type === "tab_state") {
      tabPorts.set(message.tabId, port);
      tabStates.set(message.tabId, {
        subscriptions: Array.isArray(message.state.subscriptions) ? message.state.subscriptions : [],
        focusedDocPath: message.state.focusedDocPath ?? null,
        focusedSection: message.state.focusedSection ?? null,
        updatedAt: Date.now(),
      });
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
