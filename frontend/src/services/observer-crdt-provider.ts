/**
 * ObserverCrdtProvider — Read-only Y.Doc sync via /ws/crdt/<docPath>.
 *
 * Lightweight variant of CrdtProvider for non-editing viewers.
 * Receives Y.Doc updates but never sends YJS_UPDATE, SECTION_FOCUS,
 * or ACTIVITY_PULSE. No Awareness, no dirty tracking.
 *
 * Binary protocol (subset of crdt-sync.ts):
 *   0x00 SYNC_STEP_1     — State vector (bidirectional for initial sync)
 *   0x01 SYNC_STEP_2     — State diff (bidirectional for initial sync)
 *   0x02 YJS_UPDATE       — Incremental Y.js update (server → client only)
 */

import * as Y from "yjs";
import type {
  DocumentReplacementNoticePayload,
  ClientInstanceId,
  ModeTransitionRequest,
  ModeTransitionResult,
} from "../types/shared";
import {
  WS_CLOSE_DOCUMENT_REPLACED,
  WS_CLOSE_SESSION_ENDED,
  WS_CLOSE_INVALID_URL,
  WS_CLOSE_YDOC_INIT_FAILED,
} from "./crdt-close-codes";
import { encodeDocPathForWs } from "../utils/path-encoding";
import { randomUuid } from "../utils/random-uuid";

// ─── Protocol constants (must match backend/src/ws/crdt-sync.ts) ───

const MSG_SYNC_STEP_1 = 0;
const MSG_SYNC_STEP_2 = 1;
const MSG_YJS_UPDATE = 2;
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0B;
const MSG_MODE_TRANSITION_REQUEST = 0x0C;
const MSG_MODE_TRANSITION_RESULT = 0x0D;

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
  /** Fired exactly once when the initial SYNC_STEP_2 completes and the Y.Doc is
   *  fully populated. Use this for the first render rather than onChange so that
   *  fragmentToMarkdown is never called against an empty/incomplete doc. */
  onSynced?: () => void;
  /** Fired (debounced ~100ms) when the Y.Doc is updated by an editor.
   *  Only fires after the initial sync has completed (synced === true). */
  onChange?: () => void;
  /** Editing session ended — observer should fall back to REST content. */
  onSessionEnded?: () => void;
  /** Fired when the server closes this socket with code 4022 (document replaced).
   *  The provider reconnects immediately (backoff reset). */
  onSessionReinit?: () => void;
  /** Fired once, after onSynced on the post-replacement reconnection, with the replacement notice. */
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  onModeTransitionResult?: (result: ModeTransitionResult) => void;
  /** Fired when a protocol-level error occurs (e.g. malformed JSON payload).
   *  The connection is terminated after this callback. */
  onError?: (reason: string) => void;
}

// ─── Provider ──────────────────────────────────────────────────────

export class ObserverCrdtProvider {
  readonly doc: Y.Doc;

  private _synced: boolean = false;
  /** True once SYNC_STEP_2 has been received and applied. Safe to call
   *  fragmentToMarkdown only when this is true. */
  get synced(): boolean { return this._synced; }

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
  private pendingDocumentReplacementNotice: DocumentReplacementNoticePayload | null = null;
  private readonly clientInstanceId: ClientInstanceId;
  private readonly docPath: string;
  private initialTransitionRequest: ModeTransitionRequest | null = null;

  constructor(
    docPath: string,
    events: ObserverCrdtProviderEvents = {},
    opts?: { clientInstanceId?: ClientInstanceId; initialTransitionRequest?: ModeTransitionRequest },
  ) {
    this.doc = new Y.Doc();
    this.events = events;
    this.docPath = docPath;
    this.clientInstanceId = opts?.clientInstanceId ?? randomUuid();
    this.initialTransitionRequest = opts?.initialTransitionRequest ?? null;

    // docPath is canonical (leading slash) — encode segments, skip empty first from split("/").
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const encodedPath = encodeDocPathForWs(docPath);
    this.url = `${protocol}//${window.location.host}/ws/crdt/${encodedPath}?clientInstanceId=${encodeURIComponent(this.clientInstanceId)}`;
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
      // Reset sync state and pending notification on every new connection.
      this._synced = false;
      this.pendingDocumentReplacementNotice = null;
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.sendModeTransitionRequest();
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

      if (event.code === WS_CLOSE_DOCUMENT_REPLACED) {
        // Document replaced — reconnect immediately (no exponential backoff).
        this.reconnectAttempts = 0;
        this.events.onSessionReinit?.();
        this.openWebSocket();
        return;
      }

      if (event.code === WS_CLOSE_SESSION_ENDED) {
        // Session ended — notify frontend to fall back to REST content
        this.setState("disconnected");
        this.events.onSessionEnded?.();
        // Reconnect to wait for next editing session
        this.scheduleReconnect();
        return;
      }

      if (event.code >= WS_CLOSE_INVALID_URL && event.code <= WS_CLOSE_YDOC_INIT_FAILED) {
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
        // Server sends its state vector asking what we have. Observers are strictly
        // receive-only replicas — never contribute state back. joinSession already
        // sends SYNC_STEP_2 (full Y.Doc) proactively, so no response is needed.
        break;
      }
      case MSG_SYNC_STEP_2: {
        Y.applyUpdate(this.doc, payload);
        if (!this._synced) {
          this._synced = true;
          this.events.onSynced?.();
        }
        if (this.pendingDocumentReplacementNotice) {
          const n = this.pendingDocumentReplacementNotice;
          this.pendingDocumentReplacementNotice = null;
          this.events.onDocumentReplacementNotice?.(n);
        }
        this.scheduleOnChange();
        break;
      }
      case MSG_YJS_UPDATE: {
        Y.applyUpdate(this.doc, payload);
        this.scheduleOnChange();
        break;
      }
      case MSG_DOCUMENT_REPLACEMENT_NOTICE: {
        const json = new TextDecoder().decode(payload);
        try {
          this.pendingDocumentReplacementNotice = JSON.parse(json) as DocumentReplacementNoticePayload;
        } catch (err) {
          this.closeWithProtocolError(`Malformed MSG_DOCUMENT_REPLACEMENT_NOTICE payload: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        break;
      }
      case MSG_MODE_TRANSITION_RESULT: {
        const json = new TextDecoder().decode(payload);
        let result: ModeTransitionResult;
        try {
          result = JSON.parse(json) as ModeTransitionResult;
        } catch (err) {
          this.closeWithProtocolError(`Malformed MSG_MODE_TRANSITION_RESULT payload: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        this.events.onModeTransitionResult?.(result);
        break;
      }
    }
  }

  /** Surface a protocol-level parse error and terminate the connection. */
  private closeWithProtocolError(msg: string): void {
    this.events.onError?.(msg);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.scheduleReconnect();
  }

  private scheduleOnChange(): void {
    if (!this._synced) return;
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

  private sendModeTransitionRequest(): void {
    const request: ModeTransitionRequest = this.initialTransitionRequest ?? {
      requestId: randomUuid(),
      clientInstanceId: this.clientInstanceId,
      docPath: this.docPath,
      requestedMode: "observer",
      editorFocusTarget: null,
    };
    this.initialTransitionRequest = null;
    const payload = new TextEncoder().encode(JSON.stringify(request));
    this.sendRaw(MSG_MODE_TRANSITION_REQUEST, payload);
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
