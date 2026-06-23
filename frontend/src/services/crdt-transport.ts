/**
 * CrdtTransport — facade over CrdtProvider that routes wire events onto
 * a BrowserFragmentReplicaStore.
 *
 * The transport adapts CrdtProvider's event callbacks onto store mutation
 * methods so the transport layer is React-free and the dependency flows
 * transport → store (one-way).
 *
 * Lifecycle:
 *   1. `new CrdtTransport(docPath, opts)` — creates an internal CrdtProvider
 *      (which in turn creates the Y.Doc and Awareness). Exposed as readonly
 *      fields so the caller can hand them to BrowserFragmentReplicaStore.
 *   2. `attachStore(store)` — wires events to store mutation methods.
 *      Must be called before `connect()`.
 *   3. `connect()` — opens the WebSocket and begins protocol exchange.
 *   4. `destroy()` — tears down the provider and destroys the Y.Doc +
 *      Awareness. The store is unaffected (its own `destroy()` is the
 *      caller's responsibility).
 *
 * The transport relays DocSession publication-pause state to the store.
 * Per-section block-state (`section:blocked|unblocked|gone`) rides the JSON
 * application WebSocket, not this binary channel — it is routed into the store
 * by `useDocumentWebSocket.ts`, not here.
 */

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  ClientInstanceId,
  ModeTransitionRequest,
  ModeTransitionResult,
  DocumentReplacementNoticePayload,
} from "../types/shared";
import {
  CrdtProvider,
  type CrdtConnectionState,
  type PublishPauseBarrier,
} from "./crdt-provider";
import type { BrowserFragmentReplicaStore } from "./browser-fragment-replica-store";

export interface CrdtTransportOptions {
  clientInstanceId?: ClientInstanceId;
  initialTransitionRequest?: ModeTransitionRequest;
  /** Connection-state passthrough, mirroring `store.setConnectionState`. */
  onStateChange?: (state: CrdtConnectionState) => void;
  /** Fired on first successful sync, mirroring `store.setSynced(true)`. */
  onSynced?: () => void;
  /** Error passthrough, mirroring `store.setError`. */
  onError?: (reason: string) => void;
  /** Fired when a local Y.Doc update is produced. */
  onLocalUpdate?: (modifiedFragmentKeys: string[]) => void;
  /** Receipt watermark changed (Guarantee A) — mirrors `store.setReceiptAllReceived`. */
  onReceiptChange?: (summary: { allReceived: boolean; pendingFragmentKeys: string[] }) => void;
  /** Called when the server initiates a document-replacement reconnection (4022). */
  onSessionReinit?: () => void;
  /** Called when the server initiates an admin force-rebuild reconnection (4024). */
  onForceRebuild?: () => void;
  /** Delivered once after onSynced on the post-replacement reconnect. */
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  /** Server-authoritative result for this tab's requested CRDT mode transition. */
  onModeTransitionResult?: (result: ModeTransitionResult) => void;
  /** DocSession publish pause started — editors freeze. */
  onPublishPauseStart?: () => void;
  /** DocSession publish pause ended — editors may unfreeze. */
  onPublishPauseEnd?: () => void;
}

export class CrdtTransport {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  private provider: CrdtProvider;
  private store: BrowserFragmentReplicaStore | null = null;
  private readonly opts: CrdtTransportOptions;

  constructor(docPath: string, opts: CrdtTransportOptions = {}) {
    this.opts = opts;
    const doc = new Y.Doc();
    this.provider = new CrdtProvider(
      doc,
      docPath,
      {
        onStateChange: (state) => {
          this.store?.setConnectionState(state);
          this.opts.onStateChange?.(state);
        },
        onSynced: () => {
          this.store?.setSynced(true);
          this.opts.onSynced?.();
        },
        onError: (reason) => {
          this.store?.setError(reason);
          this.opts.onError?.(reason);
        },
        onLocalUpdate: (modifiedFragmentKeys) => {
          this.opts.onLocalUpdate?.(modifiedFragmentKeys);
        },
        onReceiptChange: (summary) => {
          this.store?.setReceiptAllReceived(summary.allReceived);
          this.opts.onReceiptChange?.(summary);
        },
        onSessionReinit: () => {
          this.opts.onSessionReinit?.();
        },
        onForceRebuild: () => {
          this.opts.onForceRebuild?.();
        },
        onDocumentReplacementNotice: (payload) => {
          this.opts.onDocumentReplacementNotice?.(payload);
        },
        onModeTransitionResult: (result) => {
          this.opts.onModeTransitionResult?.(result);
        },
        onPublishPauseStart: () => {
          this.store?.setPublishPaused(true);
          this.opts.onPublishPauseStart?.();
        },
        onPublishPauseEnd: () => {
          this.store?.setPublishPaused(false);
          this.opts.onPublishPauseEnd?.();
        },
      },
      {
        clientInstanceId: opts.clientInstanceId,
        initialTransitionRequest: opts.initialTransitionRequest,
      },
    );
    this.doc = doc;
    this.awareness = this.provider.awareness;
  }

  /**
   * Wire transport events to the store. Must be called before `connect()`;
   * calling it after the socket is open is allowed but will miss any events
   * that already fired.
   */
  attachStore(store: BrowserFragmentReplicaStore): void {
    this.store = store;
  }

  connect(): void {
    this.provider.connect();
  }

  get state(): CrdtConnectionState {
    return this.provider.state;
  }

  get documentPath(): string {
    return this.provider.documentPath;
  }

  disconnect(): void {
    this.provider.disconnect();
  }

  destroy(): void {
    this.provider.destroy();
    this.store = null;
  }

  /** Register the editor-freeze barrier used by the publish-pause quiescence
   *  protocol. Delegates to the provider, which owns the barrier. */
  setPublishPauseBarrier(barrier: PublishPauseBarrier | null): void {
    this.provider.setPublishPauseBarrier(barrier);
  }

  flushAndAwaitSync(timeoutMs?: number): Promise<void> {
    return this.provider.flushAndAwaitSync(timeoutMs);
  }

  onceRemoteUpdate(cb: () => void, timeoutMs?: number): void {
    this.provider.onceRemoteUpdate(cb, timeoutMs);
  }
}
