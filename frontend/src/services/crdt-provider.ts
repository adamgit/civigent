/**
 * v4 Custom Yjs WebSocket provider — per-document connection.
 *
 * The server at /ws/crdt/<docPath> uses a binary protocol:
 *
 *   0x00 (SYNC_STEP_1)     + Y.encodeStateVector()
 *   0x01 (SYNC_STEP_2)     + Y.encodeStateAsUpdate(doc, stateVector)
 *   0x02 (YJS_UPDATE)       + incremental update bytes
 *   0x03 (AWARENESS)        + encoded awareness update (opaque relay)
 *   0x04 (SESSION_FLUSHED)  + empty (notification only)
 *   0x05 (SECTION_FOCUS)    + heading path segments separated by \x00
 *   0x06 (FLUSH_STARTED)    + empty (notification only)
 *   0x07 (ACTIVITY_PULSE)   + empty (client → server: human is actively editing)
 *   0x08 (STRUCTURE_WILL_CHANGE) + JSON old→new key mapping (server → client)
 *   0x09 (SECTION_MUTATE)      + JSON { fragmentKey, markdown } (client → server)
 *   0x0A (MUTATE_RESULT)       + JSON { success, error? } (server → client)
 *
 * One connection per document. Section focus communicated via focusSection().
 */

import * as Y from "yjs";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from "y-protocols/awareness";
import type {
  RestoreNotificationPayload,
  ClientInstanceId,
  EditorFocusTarget,
  ModeTransitionRequest,
  ModeTransitionResult,
} from "../types/shared";
import {
  WS_CLOSE_AUTH_REQUIRED,
  WS_CLOSE_DOCUMENT_RESTORED,
  WS_CLOSE_IDLE_TIMEOUT,
  WS_CLOSE_INVALID_URL,
  WS_CLOSE_YDOC_INIT_FAILED,
} from "./crdt-close-codes";

// ─── Protocol constants (must match backend/src/ws/crdt-sync.ts) ───

const MSG_SYNC_STEP_1 = 0;
const MSG_SYNC_STEP_2 = 1;
const MSG_YJS_UPDATE = 2;
const MSG_AWARENESS = 3;
const MSG_SESSION_FLUSHED = 4;
const MSG_SECTION_FOCUS = 5;
const MSG_SESSION_FLUSH_STARTED = 6;
const MSG_ACTIVITY_PULSE = 7;
const MSG_STRUCTURE_WILL_CHANGE = 8;
const MSG_SECTION_MUTATE = 9;
const MSG_MUTATE_RESULT = 10;
const MSG_RESTORE_NOTIFICATION = 0x0B;
const MSG_MODE_TRANSITION_REQUEST = 0x0C;
const MSG_MODE_TRANSITION_RESULT = 0x0D;
const MSG_FLUSH_REQUEST = 0x0E;

/** Debounce interval for ACTIVITY_PULSE messages (ms). */
const PULSE_DEBOUNCE_MS = 2500;

// ─── Connection states ─────────────────────────────────────────────

export type CrdtConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface SessionFlushedPayload {
  writtenKeys: string[];
  deletedKeys: string[];
}

export interface StructureWillChangePayload {
  oldKey: string;
  newKeys: string[];
}

export interface CrdtProviderEvents {
  onStateChange?: (state: CrdtConnectionState) => void;
  onSynced?: () => void;
  onError?: (reason: string) => void;
  onIdleTimeout?: () => void;
  /** Server is about to begin flushing dirty fragments to disk. */
  onFlushStarted?: () => void;
  /** Server confirmed fragments were flushed to disk. Payload lists written/deleted keys. */
  onSessionFlushed?: (payload: SessionFlushedPayload) => void;
  /** Server is about to restructure fragments — old keys will be cleared, new keys populated. */
  onStructureWillChange?: (restructures: StructureWillChangePayload[]) => void;
  /** Fired when a local Y.Doc update is sent to the server (user keystroke).
   *  Receives the set of fragment keys (shared type names) that were modified. */
  onLocalUpdate?: (modifiedFragmentKeys: string[]) => void;
  /** Fired when the server closes this socket with code 4022 (document restored).
   *  The provider reconnects immediately (backoff reset). */
  onSessionReinit?: () => void;
  /** Fired once, after onSynced on the post-restore reconnection, with the banner payload. */
  onRestoreNotification?: (payload: RestoreNotificationPayload) => void;
  /** Server-authoritative result for this tab's requested CRDT mode transition. */
  onModeTransitionResult?: (result: ModeTransitionResult) => void;
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
  private pendingFocus: string[] | null = null;
  private updateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
  private awarenessUpdateHandler: ((changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void) | null = null;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPulseSentAt = 0;
  private lastPulsedSection: string | null = null;
  private lastTouchedFragments = new Set<string>();
  private reverseMap = new Map<object, string>();
  private lastShareSize = 0;
  private afterTxnHandler: ((txn: Y.Transaction) => void) | null = null;
  // Serialized mutate queue: one request in-flight at a time.
  // Using a queue prevents single-slot loss when concurrent callers race on pendingMutateResolve.
  private mutateQueue: Array<{
    fragmentKey: string;
    markdown: string;
    resolve: (result: { success: boolean; error?: string }) => void;
    reject: (err: Error) => void;
  }> = [];
  private mutateInFlight = false;
  private pendingRestoreNotification: RestoreNotificationPayload | null = null;
  private readonly clientInstanceId: ClientInstanceId;
  private readonly docPath: string;
  private pendingEditorFocusTarget: EditorFocusTarget | null = null;
  private initialTransitionRequest: ModeTransitionRequest | null = null;

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
    this.clientInstanceId = opts?.clientInstanceId ?? crypto.randomUUID();
    this.initialTransitionRequest = opts?.initialTransitionRequest ?? null;

    // Build WebSocket URL — per-document, no heading_path param.
    // docPath is canonical (leading slash, e.g. "/ops/strategy.md") so we
    // encode each segment and rejoin, skipping the empty first segment from split("/").
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const encodedPath = docPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    this.url = `${protocol}//${window.location.host}/ws/crdt/${encodedPath}?clientInstanceId=${encodeURIComponent(this.clientInstanceId)}`;

    // Track which fragments are modified per transaction (same pattern as backend).
    this.afterTxnHandler = (txn: Y.Transaction) => {
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
      // Every local Y.Doc update is an intentional edit — send activity pulse.
      this.sendActivityPulse();
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
    this.rejectPendingMutates(new Error("WebSocket disconnected"));
    this.setState("disconnected");
  }

  /** Permanently destroy — disconnect and remove all listeners. */
  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    // Reject all pending mutate promises so callers don't hang.
    for (const entry of this.mutateQueue) {
      entry.reject(new Error("CrdtProvider destroyed"));
    }
    this.mutateQueue = [];
    this.mutateInFlight = false;
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }
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

  /**
   * Send a SECTION_FOCUS message to the server.
   * Called when the user clicks into or arrow-keys into a section editor.
   */
  focusSection(headingPath: string[]): void {
    // Store as pending so it can be sent once the WebSocket is open.
    // This handles the race where focusSection() is called right after
    // connect() but before the WebSocket handshake completes.
    this.pendingFocus = headingPath;
    this.pendingEditorFocusTarget = headingPath.length > 0
      ? { kind: "heading_path", heading_path: headingPath }
      : { kind: "before_first_heading" };
    const payload = new TextEncoder().encode(headingPath.join("\x00"));
    this.sendRaw(MSG_SECTION_FOCUS, payload);

    // Reset pulse debounce so the first edit in this new section fires immediately.
    const sectionKey = headingPath.join("\x00");
    if (sectionKey !== this.lastPulsedSection) {
      this.lastPulseSentAt = 0;
      this.lastPulsedSection = sectionKey;
    }
  }

  /**
   * Signal that the human is actively editing (keystroke, paste, delete).
   * Debounced to ~2.5 seconds — multiple rapid calls collapse into one message.
   * The first pulse after focusing a new section fires immediately (no debounce)
   * so the idle timeout starts promptly.
   */
  sendActivityPulse(): void {
    const now = Date.now();
    if (now - this.lastPulseSentAt < PULSE_DEBOUNCE_MS) return;
    this.lastPulseSentAt = now;
    this.sendRaw(MSG_ACTIVITY_PULSE, new Uint8Array(0));
  }

  /**
   * Request an immediate server-side flush of dirty fragments to disk.
   * Used on editor blur so content is persisted before a potential page refresh.
   */
  sendFlushRequest(): void {
    this.sendRaw(MSG_FLUSH_REQUEST, new Uint8Array(0));
  }

  /**
   * Send a section mutate request to the backend.
   * The backend replaces the fragment content and broadcasts the Y.Doc update.
   * Returns a promise that resolves when the server sends MSG_MUTATE_RESULT.
   *
   * Requests are serialized: only one is in-flight at a time. Concurrent callers
   * are queued and dispatched in FIFO order once the previous result arrives.
   * All pending promises are rejected if the provider is disconnected or destroyed.
   */
  sendSectionMutate(fragmentKey: string, markdown: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
      this.mutateQueue.push({ fragmentKey, markdown, resolve, reject });
      this.drainMutateQueue();
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
      this.pendingRestoreNotification = null;
      this.reconnectAttempts = 0;
      this.setState("connected");
      this.sendModeTransitionRequest();
      this.sendSyncStep1();

      // Broadcast local awareness state on connect.
      const encoded = encodeAwarenessUpdate(this.awareness, [
        this.doc.clientID,
      ]);
      this.sendRaw(MSG_AWARENESS, encoded);

      // Send any section focus that was requested before the WS was open.
      if (this.pendingFocus) {
        const payload = new TextEncoder().encode(this.pendingFocus.join("\x00"));
        this.sendRaw(MSG_SECTION_FOCUS, payload);
        this.pendingFocus = null;
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      this.handleMessage(data);
    };

    this.ws.onclose = (event: CloseEvent) => {
      this.ws = null;
      this.synced = false;
      // Reject any in-flight mutate request — the socket is closed so the server
      // will not send MSG_MUTATE_RESULT for it. This prevents callers from hanging.
      this.rejectPendingMutates(new Error(`WebSocket closed (code ${event.code})`));

      if (event.code === WS_CLOSE_DOCUMENT_RESTORED) {
        // Document restored — reconnect immediately (no exponential backoff).
        this.reconnectAttempts = 0;
        this.events.onSessionReinit?.();
        this.openWebSocket();
        return;
      }

      if (event.code === WS_CLOSE_AUTH_REQUIRED) {
        this.setState("disconnected");
        return;
      }
      if (event.code === WS_CLOSE_IDLE_TIMEOUT) {
        this.setState("disconnected");
        this.events.onIdleTimeout?.();
        return;
      }
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
        if (this.pendingRestoreNotification) {
          const n = this.pendingRestoreNotification;
          this.pendingRestoreNotification = null;
          this.events.onRestoreNotification?.(n);
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
      case MSG_SESSION_FLUSH_STARTED: {
        this.events.onFlushStarted?.();
        break;
      }
      case MSG_SESSION_FLUSHED: {
        // Payload: newline-separated written keys, \x00 separator, newline-separated deleted keys.
        const text = new TextDecoder().decode(payload);
        const nullIdx = text.indexOf("\x00");
        const modifiedPart = nullIdx >= 0 ? text.slice(0, nullIdx) : text;
        const deletedPart = nullIdx >= 0 ? text.slice(nullIdx + 1) : "";
        const writtenKeys = modifiedPart ? modifiedPart.split("\n").filter(Boolean) : [];
        const deletedKeys = deletedPart ? deletedPart.split("\n").filter(Boolean) : [];
        this.events.onSessionFlushed?.({ writtenKeys, deletedKeys });
        break;
      }
      case MSG_STRUCTURE_WILL_CHANGE: {
        // Payload: JSON array of { oldKey: string, newKeys: string[] }
        const json = new TextDecoder().decode(payload);
        let restructures: StructureWillChangePayload[];
        try {
          restructures = JSON.parse(json) as StructureWillChangePayload[];
        } catch (err) {
          this.closeWithProtocolError(`Malformed MSG_STRUCTURE_WILL_CHANGE payload: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        this.events.onStructureWillChange?.(restructures);
        break;
      }
      case MSG_MUTATE_RESULT: {
        const json = new TextDecoder().decode(payload);
        let result: { success: boolean; error?: string };
        try {
          result = JSON.parse(json) as { success: boolean; error?: string };
        } catch (err) {
          // Parse failed — reject the in-flight entry so callers don't hang.
          const head = this.mutateQueue.shift();
          this.mutateInFlight = false;
          if (head) {
            head.reject(new Error(`Malformed MSG_MUTATE_RESULT payload: ${err instanceof Error ? err.message : String(err)}`));
          }
          this.drainMutateQueue();
          break;
        }
        const head = this.mutateQueue.shift();
        this.mutateInFlight = false;
        if (head) {
          head.resolve(result);
        }
        // Send next queued request, if any.
        this.drainMutateQueue();
        break;
      }
      case MSG_RESTORE_NOTIFICATION: {
        const json = new TextDecoder().decode(payload);
        try {
          this.pendingRestoreNotification = JSON.parse(json) as RestoreNotificationPayload;
        } catch (err) {
          this.closeWithProtocolError(`Malformed MSG_RESTORE_NOTIFICATION payload: ${err instanceof Error ? err.message : String(err)}`);
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
      default:
        // Unknown message type — ignore.
        break;
    }
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
      requestId: crypto.randomUUID(),
      clientInstanceId: this.clientInstanceId,
      docPath: this.docPath,
      requestedMode: "editor",
      editorFocusTarget: this.pendingEditorFocusTarget,
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
    this.rejectPendingMutates(new Error(msg));
  }

  private drainMutateQueue(): void {
    if (this.mutateInFlight || this.mutateQueue.length === 0) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Socket not open — reject everything rather than hanging in-flight indefinitely.
      this.rejectPendingMutates(new Error("WebSocket not open"));
      return;
    }
    const next = this.mutateQueue[0];
    this.mutateInFlight = true;
    const json = JSON.stringify({ fragmentKey: next.fragmentKey, markdown: next.markdown });
    const payload = new TextEncoder().encode(json);
    this.sendRaw(MSG_SECTION_MUTATE, payload);
  }

  private rejectPendingMutates(err: Error): void {
    const entries = this.mutateQueue.splice(0);
    this.mutateInFlight = false;
    for (const entry of entries) {
      entry.reject(err);
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