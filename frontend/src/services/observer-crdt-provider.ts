import * as Y from "yjs";
import type {
  DocumentReplacementNoticePayload,
  ClientInstanceId,
  ModeTransitionRequest,
  ModeTransitionResult,
} from "../types/shared";
import { DocPath } from "../types/shared";
import {
  WS_CLOSE_DOCUMENT_REPLACED,
  WS_CLOSE_ADMIN_REBUILD,
  WS_CLOSE_SYSTEM_LOCKDOWN,
  WS_CLOSE_SESSION_ENDED,
  WS_CLOSE_INVALID_URL,
  WS_CLOSE_YDOC_INIT_FAILED,
} from "./crdt-close-codes";
import { encodeDocPathForWs } from "../utils/path-encoding";
import { randomUuid } from "../utils/random-uuid";
import { recallDocSessionId } from "./doc-session-memory";
import {
  ensurePageWsLifecycleInstalled,
  isPageWsSuspended,
  subscribePageWsWake,
} from "./page-ws-lifecycle";

const MSG_SYNC_STEP_2 = 1;
const MSG_AWARENESS = 3;
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0B;
const MSG_MODE_TRANSITION_REQUEST = 0x0C;
const MSG_MODE_TRANSITION_RESULT = 0x0D;
const MSG_DOC_PUBLISH_PAUSE_START = 0x10;
const MSG_DOC_PUBLISH_PAUSE_END = 0x12;
const MSG_LIVE_SECTIONS_BOOTSTRAP = 0x14;
const MSG_LIVE_SECTIONS_UPDATE = 0x15;

// ─── Connection states ─────────────────────────────────────────────

export type ObserverConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface ObserverCrdtProviderEvents {
  onStateChange?: (state: ObserverConnectionState) => void;
  onBootstrapApplied?: () => void;
  /** Editing session ended — observer should fall back to REST content. */
  onSessionEnded?: () => void;
  /** Fired when the server closes this socket with code 4022 (document replaced).
   *  The provider reconnects immediately (backoff reset). */
  onSessionReinit?: () => void;
  /** Fired once on the post-replacement reconnection, after the live-sections
   *  bootstrap has applied (never before the doc is filled), with the notice. */
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  onModeTransitionResult?: (result: ModeTransitionResult) => void;
  onLiveSectionFrame?: (opcode: number, payload: Uint8Array) => void;
  /** Fired after a MSG_SYNC_STEP_2 update is applied to the shared Y.Doc, so a
   *  passively-watching (no mounted Milkdown) viewer can re-read `paintMarkdown`
   *  and repaint its ReactMarkdown body. NOT a general doc.on("update") — only
   *  this inbound-sync opcode fires it, so local keystrokes don't trigger it. */
  onDocUpdated?: () => void;
  /** Fired when a protocol-level error occurs (e.g. malformed JSON payload).
   *  The connection is terminated after this callback. */
  onError?: (reason: string) => void;
}

// ─── Provider ──────────────────────────────────────────────────────

export class ObserverCrdtProvider {
  readonly doc: Y.Doc;

  private _bootstrapApplied: boolean = false;
  /** True once the first live-sections bootstrap of this connection has been
   *  applied by the replica. Safe to call fragmentToMarkdown only when true. */
  get bootstrapApplied(): boolean { return this._bootstrapApplied; }

  private ws: WebSocket | null = null;
  private _state: ObserverConnectionState = "disconnected";
  private readonly url: string;
  private readonly events: ObserverCrdtProviderEvents;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs = 1000;
  private readonly maxReconnectDelayMs = 15000;
  private reconnectAttempts = 0;
  private destroyed = false;
  private pendingDocumentReplacementNotice: DocumentReplacementNoticePayload | null = null;
  private readonly clientInstanceId: ClientInstanceId;
  private readonly docPath: string;
  private initialTransitionRequest: ModeTransitionRequest | null = null;
  /** Socket was closed while the tab was frozen/BFCached/hidden — reopen on wake
   *  without entering the user-visible `reconnecting` state. */
  private wakeReconnectPending = false;
  private readonly cancelPageWake: () => void;

  /** True when the Y.Doc is externally owned (by a LiveSectionReplica). Such a
   *  doc must NOT be destroyed by this provider — the replica owns its lifetime. */
  private readonly ownsDoc: boolean;

  constructor(
    docPath: string,
    events: ObserverCrdtProviderEvents = {},
    opts?: { clientInstanceId?: ClientInstanceId; initialTransitionRequest?: ModeTransitionRequest; doc?: Y.Doc },
  ) {
    // A replica-owned doc may be passed in so the socket syncs INTO the replica's
    // single shared Y.Doc; otherwise the provider mints its own (legacy path).
    this.doc = opts?.doc ?? new Y.Doc();
    this.ownsDoc = opts?.doc === undefined;
    this.events = events;
    this.docPath = docPath;
    this.clientInstanceId = opts?.clientInstanceId ?? randomUuid();
    this.initialTransitionRequest = opts?.initialTransitionRequest ?? null;

    // docPath is canonical (leading slash) — encode segments, skip empty first from split("/").
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const encodedPath = encodeDocPathForWs(docPath);
    this.url = `${protocol}//${window.location.host}/ws/crdt/${encodedPath}?clientInstanceId=${encodeURIComponent(this.clientInstanceId)}`;

    ensurePageWsLifecycleInstalled();
    this.cancelPageWake = subscribePageWsWake(() => this.onPageWake());
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
    this.wakeReconnectPending = false;
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
    this.cancelPageWake();
    this.disconnect();
    // Only destroy the Y.Doc if this provider minted it. A replica-owned doc
    // outlives the provider (observer → editor promotion reuses it).
    if (this.ownsDoc) this.doc.destroy();
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
      // Reset bootstrap-applied state and pending notification on every new connection.
      this._bootstrapApplied = false;
      this.pendingDocumentReplacementNotice = null;
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.sendModeTransitionRequest();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      this.handleMessage(data);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.ws = null;

      if (event.code === WS_CLOSE_DOCUMENT_REPLACED || event.code === WS_CLOSE_ADMIN_REBUILD) {
        // Document replaced (restore 4022) or admin force-rebuild (4024) — both
        // reconnect immediately (no exponential backoff) and reseed. Observers
        // are not editor sockets, so there is no publish-ready responsibility.
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

      if (event.code === WS_CLOSE_SYSTEM_LOCKDOWN) {
        // Backup / restore lockdown reads as "temporary server unavailable".
        // Fall straight into the standard backoff/reconnect path — the
        // "reconnecting" state emitted by scheduleReconnect() is the whole
        // UI cue, matching how other short server unavailability is shown.
        this.scheduleReconnect();
        return;
      }

      if (event.code >= WS_CLOSE_INVALID_URL && event.code <= WS_CLOSE_YDOC_INIT_FAILED) {
        // Permanent rejection — don't reconnect
        this.setState("disconnected");
        return;
      }

      // Tab freeze / BFCache closes page-owned sockets. Stay quietly "connected"
      // and reopen on wake — scheduleReconnect() would flash the page banner.
      if (isPageWsSuspended()) {
        this.wakeReconnectPending = true;
        this.clearReconnectTimer();
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
      case MSG_SYNC_STEP_2: {
        Y.applyUpdate(this.doc, payload);
        this.events.onDocUpdated?.();
        break;
      }
      case MSG_AWARENESS:
      case MSG_DOC_PUBLISH_PAUSE_START:
      case MSG_DOC_PUBLISH_PAUSE_END:
        break;
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
      case MSG_LIVE_SECTIONS_BOOTSTRAP: {
        this.events.onLiveSectionFrame?.(msgType, payload);
        if (this.destroyed) break;
        if (!this._bootstrapApplied) {
          this._bootstrapApplied = true;
          this.events.onBootstrapApplied?.();
        }
        if (this.pendingDocumentReplacementNotice) {
          const n = this.pendingDocumentReplacementNotice;
          this.pendingDocumentReplacementNotice = null;
          this.events.onDocumentReplacementNotice?.(n);
        }
        break;
      }
      case MSG_LIVE_SECTIONS_UPDATE: {
        this.events.onLiveSectionFrame?.(msgType, payload);
        break;
      }
      default: {
        this.closeWithProtocolError(
          `Unexpected CRDT opcode 0x${msgType.toString(16)}`,
        );
        return;
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

  private sendRaw(msgType: number, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = new Uint8Array(1 + payload.length);
    msg[0] = msgType;
    msg.set(payload, 1);
    this.ws.send(msg);
  }

  private sendModeTransitionRequest(): void {
    const request: ModeTransitionRequest = {
      ...(this.initialTransitionRequest ?? {
        requestId: randomUuid(),
        clientInstanceId: this.clientInstanceId,
        docPath: DocPath.parse(this.docPath),
        requestedMode: "observer",
        editorFocusTarget: null,
      }),
      previous_doc_session_id: recallDocSessionId(this.docPath),
    };
    this.initialTransitionRequest = null;
    const payload = new TextEncoder().encode(JSON.stringify(request));
    this.sendRaw(MSG_MODE_TRANSITION_REQUEST, payload);
  }

  private onPageWake(): void {
    if (this.destroyed || !this.wakeReconnectPending) return;
    this.wakeReconnectPending = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.openWebSocket();
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
