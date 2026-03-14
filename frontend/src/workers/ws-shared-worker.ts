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

type WorkerInboundMessage = RegisterMessage | UnregisterMessage | TabStateMessage | WsSendMessage;

const workerScope = self as unknown as {
  location: Location;
  onconnect: ((event: MessageEvent) => void) | null;
};

const tabPorts = new Map<string, MessagePort>();
const tabStates = new Map<string, TabState>();

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
    syncSocketState();
  });

  socket.addEventListener("message", (raw) => {
    try {
      const serverEvent = JSON.parse(String(raw.data));
      broadcastServerEvent(serverEvent);
    } catch {
      // Ignore malformed transport payloads.
    }
  });

  socket.addEventListener("close", () => {
    if (ws === socket) {
      ws = null;
    }
    if (tabPorts.size === 0) {
      return;
    }
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
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
      ws.send(JSON.stringify({ subscribe: path }));
    }
  }
  for (const path of appliedSubscriptions) {
    if (!desired.subscriptions.has(path)) {
      ws.send(JSON.stringify({ unsubscribe: path }));
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
      ws.send(
        JSON.stringify({
          type: "section_focus",
          doc_path: desired.focusedSection.docPath,
          heading_path: desired.focusedSection.headingPath,
        }),
      );
    } else if (appliedFocusedSection) {
      ws.send(
        JSON.stringify({
          type: "section_blur",
          doc_path: appliedFocusedSection.docPath,
          heading_path: appliedFocusedSection.headingPath,
        }),
      );
    }
    appliedFocusedSection = desired.focusedSection;
  }

  if (!desired.focusedSection && appliedFocusedDocPath !== desired.focusedDocPath) {
    if (desired.focusedDocPath) {
      ws.send(
        JSON.stringify({
          type: "document_focus",
          doc_path: desired.focusedDocPath,
        }),
      );
    } else {
      ws.send(JSON.stringify({ type: "document_blur" }));
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
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message.message));
      }
    }
  });
};
