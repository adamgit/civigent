/**
 * v4 Custom Yjs WebSocket provider — per-document connection.
 *
 * The server at /ws/crdt/<docPath> uses a binary protocol (must match
 * backend/src/ws/crdt-ws-frames.ts):
 *
 *   0x00 (SYNC_STEP_1)               + Y.encodeStateVector()
 *   0x01 (SYNC_STEP_2)               + Y.encodeStateAsUpdate(doc, stateVector)
 *   0x02 (YJS_UPDATE)                + incremental update bytes
 *   0x03 (AWARENESS)                 + encoded awareness update (opaque relay)
 *   0x0B (DOCUMENT_REPLACEMENT_NOTICE) + JSON (server → client reconnect notice)
 *   0x0C (MODE_TRANSITION_REQUEST)   + JSON (client → server)
 *   0x0D (MODE_TRANSITION_RESULT)    + JSON (server → client)
 *   0x10 (DOC_PUBLISH_PAUSE_START)   + empty (server → client: freeze editors)
 *   0x11 (DOC_PUBLISH_READY)         + empty (client → server: ordered ready ack)
 *   0x12 (DOC_PUBLISH_PAUSE_END)     + empty (server → client: editors may unfreeze)
 *
 * One connection per document.
 *
 * The legacy session-overlay / focus / pulse / mutate / receipt / idle-timeout
 * protocol items (0x04-0x07, 0x09, 0x0A, 0x0F) are removed (spec 05 §4 >
 * Removed message types). The DocSession publish-pause control messages ride
 * this same ordered editor channel as Yjs updates; processing a
 * `doc_publish_ready` ack proves earlier Yjs updates from this socket have
 * already reached the DocSession actor. Section block-state events
 * (`section:blocked|unblocked|gone`) travel on the JSON application WebSocket,
 * NOT here (see useDocumentWebSocket.ts).
 */

import * as Y from "yjs";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from "y-protocols/awareness";
import type {
  DocumentReplacementNoticePayload,
  ClientInstanceId,
  ModeTransitionRequest,
  ModeTransitionResult,
} from "../types/shared";
import {
  WS_CLOSE_AUTH_REQUIRED,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_DOCUMENT_REPLACED,
  WS_CLOSE_ADMIN_REBUILD,
  WS_CLOSE_INVALID_URL,
  WS_CLOSE_YDOC_INIT_FAILED,
} from "./crdt-close-codes";
import { apiClient } from "./api-client";
import { encodeDocPathForWs } from "../utils/path-encoding";
import { randomUuid } from "../utils/random-uuid";

// ─── Protocol constants (must match backend/src/ws/crdt-ws-frames.ts) ───

const MSG_SYNC_STEP_1 = 0;
const MSG_SYNC_STEP_2 = 1;
const MSG_YJS_UPDATE = 2;
const MSG_AWARENESS = 3;
const MSG_DOCUMENT_REPLACEMENT_NOTICE = 0x0B;
const MSG_MODE_TRANSITION_REQUEST = 0x0C;
const MSG_MODE_TRANSITION_RESULT = 0x0D;
const MSG_DOC_PUBLISH_PAUSE_START = 0x10;
const MSG_DOC_PUBLISH_READY = 0x11;
const MSG_DOC_PUBLISH_PAUSE_END = 0x12;
const MSG_SECTION_MOVE_REQUEST = 0x13;

// ─── Connection states ─────────────────────────────────────────────

export type CrdtConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/**
 * Callback the editor registry sets so the provider can drive the publish
 * pause quiescence barrier. The provider calls `freeze()` on
 * `doc_publish_pause_start`, then awaits the returned promise (which resolves
 * once every mounted + future-mounted editor has stopped producing Yjs
 * transactions) before sending `doc_publish_ready`. `unfreeze()` is called on
 * `doc_publish_pause_end`.
 */
export interface PublishPauseBarrier {
  /** Freeze all mounted + future-mounted editors. Resolves once the client has
   *  stopped producing local Yjs transactions for the whole document. */
  freeze: () => Promise<void>;
  /** Unfreeze editors — called only on doc_publish_pause_end. */
  unfreeze: () => void;
}

export interface CrdtProviderEvents {
  onStateChange?: (state: CrdtConnectionState) => void;
  onSynced?: () => void;
  onError?: (reason: string) => void;
  /** Fired when a local Y.Doc update is sent to the server (user keystroke).
   *  Receives the set of fragment keys (shared type names) that were modified. */
  onLocalUpdate?: (modifiedFragmentKeys: string[]) => void;
  /** Fired when the server closes this socket with code 4022 (document replaced).
   *  The provider reconnects immediately (backoff reset). */
  onSessionReinit?: () => void;
  /** Fired when the server closes this socket with the admin force-rebuild code
   *  (4024). Behaves like 4022: reconnect immediately, reseed canonical. */
  onForceRebuild?: () => void;
  /** Fired once, after onSynced on the post-replacement reconnection, with the replacement notice. */
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  /** Server-authoritative result for this tab's requested CRDT mode transition. */
  onModeTransitionResult?: (result: ModeTransitionResult) => void;
  /** Server began a DocSession publish attempt — freeze all editors. */
  onPublishPauseStart?: () => void;
  /** Server ended the publish attempt (commit or abort) — editors may unfreeze. */
  onPublishPauseEnd?: () => void;
}

// ─── Provider ──────────────────────────────────────────────────────

export class CrdtProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  private ws: WebSocket | null = null;
  private _state: CrdtConnectionState = "disconnected";
  private readonly url: string;
  private readonly events: CrdtProviderEvents;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reconnectDelayMs = 1000;
  private readonly maxReconnectDelayMs = 15000;
  private reconnectAttempts = 0;
  private destroyed = false;
  private synced = false;
  private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
  private awarenessUpdateHandler: ((changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void) | null = null;
  private lastTouchedFragments = new Set<string>();
  private reverseMap = new Map<object, string>();
  private lastShareSize = 0;
  private afterTxnHandler: ((txn: Y.Transaction) => void) | null = null;
  private pendingDocumentReplacementNotice: DocumentReplacementNoticePayload | null = null;
  private readonly clientInstanceId: ClientInstanceId;
  private readonly docPath: string;
  private initialTransitionRequest: ModeTransitionRequest | null = null;

  // Publish-pause quiescence barrier state. The provider is the single owner.
  private publishPaused = false;
  private publishReadySent = false;
  private barrier: PublishPauseBarrier | null = null;

  constructor(
    doc: Y.Doc,
    docPath: string,
    events: CrdtProviderEvents = {},
    opts?: { clientInstanceId?: ClientInstanceId; initialTransitionRequest?: ModeTransitionRequest },
  ) {
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.events = events;
    this.docPath = docPath;
    this.clientInstanceId = opts?.clientInstanceId ?? randomUuid();
    this.initialTransitionRequest = opts?.initialTransitionRequest ?? null;

    // Build WebSocket URL — per-document, no heading_path param.
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const encodedPath = encodeDocPathForWs(docPath);
    this.url = `${protocol}//${window.location.host}/ws/crdt/${encodedPath}?clientInstanceId=${encodeURIComponent(this.clientInstanceId)}`;

    // Track which fragments are modified per transaction (same pattern as backend).
    this.afterTxnHandler = (txn: Y.Transaction) => {
      if (txn.origin === this) return;
      if (doc.share.size !== this.lastShareSize) {
        this.reverseMap = new Map();
        for (const [name, shared] of doc.share) {
          this.reverseMap.set(shared, name);
        }
        this.lastShareSize = doc.share.size;
      }
      for (const [type] of txn.changed) {
        let current: any = type;
        while (current._item?.parent) current = current._item.parent;
        const name = this.reverseMap.get(current);
        if (name) this.lastTouchedFragments.add(name);
      }
    };
    doc.on("afterTransaction", this.afterTxnHandler);

    // Listen for local Y.Doc changes to broadcast.
    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      this.sendUpdate(update);
      const touched = [...this.lastTouchedFragments];
      this.lastTouchedFragments.clear();
      this.events.onLocalUpdate?.(touched);
    };
    this.doc.on("update", this.updateHandler);

    // Listen for local awareness changes to broadcast.
    this.awarenessUpdateHandler = (changes, origin) => {
      if (origin === "remote") return;
      const changedClients = [
        ...changes.added,
        ...changes.updated,
        ...changes.removed,
      ];
      const encoded = encodeAwarenessUpdate(this.awareness, changedClients);
      this.sendRaw(MSG_AWARENESS, encoded);
    };
    this.awareness.on("update", this.awarenessUpdateHandler);
  }

  get state(): CrdtConnectionState {
    return this._state;
  }

  /** Start connecting. */
  connect(): void {
    if (this.destroyed) return;
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    this.openWebSocket();
  }

  /** Disconnect and stop reconnecting. */
  disconnect(): void {
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  /** Permanently destroy — disconnect and remove all listeners. */
  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.barrier = null;
    if (this.afterTxnHandler) {
      this.doc.off("afterTransaction", this.afterTxnHandler);
      this.afterTxnHandler = null;
    }
    if (this.updateHandler) {
      this.doc.off("update", this.updateHandler);
      this.updateHandler = null;
    }
    if (this.awarenessUpdateHandler) {
      this.awareness.off("update", this.awarenessUpdateHandler);
      this.awarenessUpdateHandler = null;
    }
    // Mute awareness events during destruction.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    this.awareness.emit = () => {};
    this.awareness.destroy();
  }

  // ─── Publish-pause quiescence barrier ──────────────────────────

  /**
   * Register the editor-freeze barrier. The editor registry calls this once it
   * is mounted so the provider can freeze editors during a publish pause and
   * confirm quiescence before sending `doc_publish_ready`. Idempotent.
   */
  setPublishPauseBarrier(barrier: PublishPauseBarrier | null): void {
    this.barrier = barrier;
  }

  /** True while a DocSession publish pause is active for this document. */
  get isPublishPaused(): boolean {
    return this.publishPaused;
  }

  // ─── Cross-section move (MW-10) ────────────────────────────────

  /**
   * Request a backend-owned cross-section move: reposition `sourceHeadingPath`
   * before/after the sibling `targetHeadingPath`. Y.js has no `moveTo` between
   * top-level types, so the structural reorder is owned by the backend (spec 05
   * §Structural Normalization), driven through the DocSession actor. The backend
   * applies the reorder and fans out the resulting Y.Doc state.
   *
   * Resolves when the server-applied reorder arrives as a remote Y.Doc update
   * (the fan-out), or rejects on `timeoutMs` / disconnect. The backend sends no
   * dedicated result frame; the applied Y.Doc update is the acknowledgement.
   */
  sendSectionMove(
    req: { sourceHeadingPath: string[]; targetHeadingPath: string[]; position: "before" | "after" },
    timeoutMs = 5000,
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CRDT session disconnected — move cancelled"));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onUpdate = (_update: Uint8Array, origin: unknown) => {
        // The server fan-out arrives as a remote update (origin === this, set by
        // applyUpdate in handleMessage). A local edit would have origin !== this.
        if (origin !== this) return;
        finish();
      };
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.doc.off("update", onUpdate);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("Section move timed out — the server did not apply it.")),
        timeoutMs,
      );
      this.doc.on("update", onUpdate);
      const json = new TextEncoder().encode(JSON.stringify(req));
      this.sendRaw(MSG_SECTION_MOVE_REQUEST, json);
    });
  }

  // ─── Internal ─────────────────────────────────────────

  private setState(state: CrdtConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.events.onStateChange?.(state);
  }

  private openWebSocket(): void {
    if (this.destroyed) return;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";
    } catch (err) {
      this.setState("error");
      this.events.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }

    this.ws.onopen = () => {
      // Reset sync state and pending notification on every new connection.
      this.synced = false;
      this.pendingDocumentReplacementNotice = null;
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.sendModeTransitionRequest();
      this.sendSyncStep1();

      // Broadcast local awareness state on connect.
      const encoded = encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID,
      ]);
      this.sendRaw(MSG_AWARENESS, encoded);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      this.handleMessage(data);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.ws = null;
      this.synced = false;

      if (event.code === WS_CLOSE_DOCUMENT_REPLACED) {
        // Document replaced (restore) — reconnect immediately (no backoff).
        this.reconnectAttempts = 0;
        this.events.onSessionReinit?.();
        this.openWebSocket();
        return;
      }

      if (event.code === WS_CLOSE_ADMIN_REBUILD) {
        // Admin force-rebuild — behaves like 4022: reconnect immediately,
        // reseed canonical. (Spec 05 §4 > Close codes.)
        this.reconnectAttempts = 0;
        this.events.onForceRebuild?.();
        this.openWebSocket();
        return;
      }

      if (event.code === WS_CLOSE_AUTH_REQUIRED || event.code === WS_CLOSE_AUTH_FAILED) {
        // Auth expired/invalid — attempt one browser silent refresh then reconnect
        apiClient.refreshAuthSession().then((refreshed) => {
          if (refreshed) {
            this.reconnectAttempts = 0;
            this.openWebSocket();
          } else {
            this.setState("disconnected");
            this.events.onError?.("Authentication expired");
          }
        });
        return;
      }
      // (4020 idle_timeout removed — there is no idle timer in this architecture.)
      if (event.code >= WS_CLOSE_INVALID_URL && event.code <= WS_CLOSE_YDOC_INIT_FAILED) {
        this.setState("error");
        this.events.onError?.(event.reason || "Server rejected connection");
        return;
      }

      // Connection failure — surface the error, then attempt reconnect.
      this.setState("error");
      const detail = event.reason
        || (event.code === 1006
          ? `WebSocket connection to ${this.url} failed (server unreachable)`
          : `WebSocket closed unexpectedly (code ${event.code})`);
      this.events.onError?.(detail);
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onerror is always followed by onclose, so just let onclose handle it.
    };
  }

  private handleMessage(data: Uint8Array): void {
    if (data.length === 0) return;
    const msgType = data[0];
    const payload = data.subarray(1);

    switch (msgType) {
      case MSG_SYNC_STEP_1: {
        // Server requests our state — reply with sync step 2.
        const stateVector = payload;
        const diff = Y.encodeStateAsUpdate(this.doc, stateVector);
        this.sendRaw(MSG_SYNC_STEP_2, diff);
        break;
      }
      case MSG_SYNC_STEP_2: {
        // Server sends state diff — apply it.
        Y.applyUpdate(this.doc, payload, this);
        if (!this.synced) {
          this.synced = true;
          this.events.onSynced?.();
        }
        if (this.pendingDocumentReplacementNotice) {
          const n = this.pendingDocumentReplacementNotice;
          this.pendingDocumentReplacementNotice = null;
          this.events.onDocumentReplacementNotice?.(n);
        }
        break;
      }
      case MSG_YJS_UPDATE: {
        Y.applyUpdate(this.doc, payload, this);
        break;
      }
      case MSG_AWARENESS: {
        applyAwarenessUpdate(this.awareness, payload, "remote");
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
      case MSG_DOC_PUBLISH_PAUSE_START: {
        this.handlePublishPauseStart();
        break;
      }
      case MSG_DOC_PUBLISH_PAUSE_END: {
        this.handlePublishPauseEnd();
        break;
      }
      default:
        // Unknown message type — ignore.
        break;
    }
  }

  /**
   * doc_publish_pause_start: freeze editors and, once local Yjs transaction
   * production has quiesced for all mounted + future-mounted editors, send
   * `doc_publish_ready` exactly once. The provider is the single owner of
   * this barrier (no premature ready). Editors stay frozen until pause_end.
   */
  private handlePublishPauseStart(): void {
    if (this.publishPaused) return; // already paused — ignore duplicate start
    this.publishPaused = true;
    this.publishReadySent = false;
    this.events.onPublishPauseStart?.();

    const send = () => {
      // Guard against late resolution after a pause_end / disconnect.
      if (!this.publishPaused || this.publishReadySent || this.destroyed) return;
      this.publishReadySent = true;
      this.sendRaw(MSG_DOC_PUBLISH_READY, new Uint8Array(0));
    };

    if (this.barrier) {
      this.barrier.freeze().then(send, send);
    } else {
      // No editor barrier registered — nothing local is producing transactions,
      // so the client is trivially quiescent.
      send();
    }
  }

  /**
   * doc_publish_pause_end: unfreeze editors. Guarded so a pause_end without a
   * prior pause_start is a no-op (spec 05 §4 > DocSession publish pause).
   */
  private handlePublishPauseEnd(): void {
    if (!this.publishPaused) return; // no active pause — no-op guard
    this.publishPaused = false;
    this.publishReadySent = false;
    this.barrier?.unfreeze();
    this.events.onPublishPauseEnd?.();
  }

  private sendSyncStep1(): void {
    const stateVector = Y.encodeStateVector(this.doc);
    this.sendRaw(MSG_SYNC_STEP_1, stateVector);
  }

  private sendUpdate(update: Uint8Array): void {
    this.sendRaw(MSG_YJS_UPDATE, update);
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
      requestedMode: "editor",
      editorFocusTarget: null,
    };
    this.initialTransitionRequest = null;
    const payload = new TextEncoder().encode(JSON.stringify(request));
    this.sendRaw(MSG_MODE_TRANSITION_REQUEST, payload);
  }

  /** Surface a protocol-level parse error and terminate the connection. */
  private closeWithProtocolError(msg: string): void {
    this.setState("error");
    this.events.onError?.(msg);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
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
