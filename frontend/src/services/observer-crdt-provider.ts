/**
 * ObserverCrdtProvider — Read-only Y.Doc sync via /ws/crdt-observe/<docPath>.
 *
 * Lightweight variant of CrdtProvider for non-editing viewers.
 * Receives Y.Doc updates but never sends YJS_UPDATE, SECTION_FOCUS,
 * or ACTIVITY_PULSE. No Awareness, no dirty tracking.
 *
 * Binary protocol (subset of crdt-sync.ts):
 *   0x00 SYNC_STEP_1     — State vector (bidirectional for initial sync)
 *   0x01 SYNC_STEP_2     — State diff (bidirectional for initial sync)
 *   0x02 YJS_UPDATE       — Incremental Y.js update (server → client only)
 *   0x04 SESSION_FLUSHED  — Flush notification (server → client)
 *   0x08 STRUCTURE_WILL_CHANGE — Restructure notification (server → client)
 */

import * as Y from "yjs";

// ─── Protocol constants (must match backend/src/ws/crdt-sync.ts) ───

const MSG_SYNC_STEP_1 = 0;
const MSG_SYNC_STEP_2 = 1;
const MSG_YJS_UPDATE = 2;
const MSG_SESSION_FLUSHED = 4;
const MSG_STRUCTURE_WILL_CHANGE = 8;

/** Debounce interval for onChange callbacks (ms). */
const CHANGE_DEBOUNCE_MS = 100;

// ─── Connection states ─────────────────────────────────────────────

export type ObserverConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface ObserverCrdtProviderEvents {
  onStateChange?: (state: ObserverConnectionState) => void;
  /** Fired (debounced ~100ms) when the Y.Doc is updated by an editor. */
  onChange?: () => void;
  /** Server confirmed fragments were flushed to disk. */
  onSessionFlushed?: () => void;
  /** Server is about to restructure fragments. */
  onStructureWillChange?: (restructures: Array<{ oldKey: string; newKeys: string[] }>) => void;
  /** Editing session ended — observer should fall back to REST content. */
  onSessionEnded?: () => void;
}

// ─── Provider ──────────────────────────────────────────────────────

export class ObserverCrdtProvider {
  readonly doc: Y.Doc;

  private ws: WebSocket | null = null;
  private _state: ObserverConnectionState = "disconnected";
  private readonly url: string;
  private readonly events: ObserverCrdtProviderEvents;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs = 1000;
  private readonly maxReconnectDelayMs = 15000;
  private reconnectAttempts = 0;
  private destroyed = false;
  private changeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    docPath: string,
    events: ObserverCrdtProviderEvents = {},
  ) {
    this.doc = new Y.Doc();
    this.events = events;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${protocol}//${window.location.host}/ws/crdt-observe/${encodeURIComponent(docPath)}`;
  }

  get state(): ObserverConnectionState {
    return this._state;
  }

  connect(): void {
    if (this.destroyed) return;
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    this.openWebSocket();
  }

  disconnect(): void {
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    if (this.changeDebounceTimer) {
      clearTimeout(this.changeDebounceTimer);
      this.changeDebounceTimer = null;
    }
    this.doc.destroy();
  }

  // ─── Internal ─────────────────────────────────────────

  private setState(state: ObserverConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.events.onStateChange?.(state);
  }

  private openWebSocket(): void {
    if (this.destroyed) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState("connected");
      // Send sync step 1 so server can respond with current Y.Doc state
      const stateVector = Y.encodeStateVector(this.doc);
      this.sendRaw(MSG_SYNC_STEP_1, stateVector);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      this.handleMessage(data);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.ws = null;

      if (event.code === 4021) {
        // Session ended — notify frontend to fall back to REST content
        this.setState("disconnected");
        this.events.onSessionEnded?.();
        // Reconnect to wait for next editing session
        this.scheduleReconnect();
        return;
      }

      if (event.code >= 4010 && event.code <= 4019) {
        // Permanent rejection — don't reconnect
        this.setState("disconnected");
        return;
      }

      // Unexpected close — reconnect
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onerror is always followed by onclose
    };
  }

  private handleMessage(data: Uint8Array): void {
    if (data.length === 0) return;
    const msgType = data[0];
    const payload = data.subarray(1);

    switch (msgType) {
      case MSG_SYNC_STEP_1: {
        // Server requests our state — reply with sync step 2
        const diff = Y.encodeStateAsUpdate(this.doc, payload);
        this.sendRaw(MSG_SYNC_STEP_2, diff);
        break;
      }
      case MSG_SYNC_STEP_2: {
        Y.applyUpdate(this.doc, payload);
        this.scheduleOnChange();
        break;
      }
      case MSG_YJS_UPDATE: {
        Y.applyUpdate(this.doc, payload);
        this.scheduleOnChange();
        break;
      }
      case MSG_SESSION_FLUSHED: {
        this.events.onSessionFlushed?.();
        break;
      }
      case MSG_STRUCTURE_WILL_CHANGE: {
        const json = new TextDecoder().decode(payload);
        const restructures = JSON.parse(json) as Array<{ oldKey: string; newKeys: string[] }>;
        this.events.onStructureWillChange?.(restructures);
        break;
      }
    }
  }

  private scheduleOnChange(): void {
    if (this.changeDebounceTimer) return;
    this.changeDebounceTimer = setTimeout(() => {
      this.changeDebounceTimer = null;
      this.events.onChange?.();
    }, CHANGE_DEBOUNCE_MS);
  }

  private sendRaw(msgType: number, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = new Uint8Array(1 + payload.length);
    msg[0] = msgType;
    msg.set(payload, 1);
    this.ws.send(msg);
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.clearReconnectTimer();
    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelayMs,
    );
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openWebSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
