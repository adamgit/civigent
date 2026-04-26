/**
 * CrdtTransport — facade over CrdtProvider that routes wire events onto
 * a BrowserFragmentReplicaStore.
 *
 * This is a transitional layer for Store Architecture Refactor group D.
 * The long-term target is for transport code to own the WebSocket + Yjs
 * protocol directly with no React coupling. Today, CrdtProvider already
 * satisfies that shape except for the event-handler callbacks which used
 * to be wired straight into useState setters. CrdtTransport adapts those
 * callbacks onto store mutation methods so the transport layer becomes
 * React-free and the dependency flows transport → store (one-way).
 *
 * Lifecycle:
 *   1. `new CrdtTransport(docPath, opts)` — creates an internal CrdtProvider
 *      (which in turn creates the Y.Doc and Awareness). Exposed as readonly
 *      fields so the caller can hand them to BrowserFragmentReplicaStore.
 *   2. `attachStore(store)` — wires events to store mutation methods.
 *      Must be called before `connect()`.
 *   3. `connect()` — opens the WebSocket and begins protocol exchange.
 *   4. `destroy()` — tears down the provider, rejects pending mutates,
 *      destroys the Y.Doc + Awareness. The store is unaffected (its own
 *      `destroy()` is the caller's responsibility).
 *
 * This transport is a *compatibility facade*, not a true extraction.
 * CrdtProvider still owns the WebSocket, reconnect loop, mutate queue,
 * activity pulse, and section-focus logic. Future groups may flatten the
 * provider into the transport.
 */

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  ClientInstanceId,
  EditorFocusTarget,
  ModeTransitionRequest,
  ModeTransitionResult,
  DocumentReplacementNoticePayload,
} from "../types/shared";
import {
  CrdtProvider,
  type CrdtConnectionState,
  type SessionOverlayImportedPayload,
} from "./crdt-provider";
import type { BrowserFragmentReplicaStore } from "./browser-fragment-replica-store";

export interface CrdtTransportOptions {
  clientInstanceId?: ClientInstanceId;
  initialTransitionRequest?: ModeTransitionRequest;
  /** Connection-state passthrough, mirroring `store.setConnectionState`.
   *  Transitional hook for callers that still read connection state from
   *  React state instead of subscribing to the store. */
  onStateChange?: (state: CrdtConnectionState) => void;
  /** Fired on first successful sync, mirroring `store.setSynced(true)`.
   *  Transitional passthrough for React state consumers. */
  onSynced?: () => void;
  /** Error passthrough, mirroring `store.setError`. */
  onError?: (reason: string) => void;
  /** Fired when a local Y.Doc update is produced. The store's
   *  `markSectionsEdited` is already called first; this passthrough is
   *  for React state consumers that need the same signal. */
  onLocalUpdate?: (modifiedFragmentKeys: string[]) => void;
  /** Called when the server closes with WS_CLOSE_IDLE_TIMEOUT. */
  onIdleTimeout?: () => void;
  /** Called when the server initiates a document-replacement reconnection. */
  onSessionReinit?: () => void;
  /** Delivered once after onSynced on the post-replacement reconnect. */
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  /** Server-authoritative result for this tab's requested CRDT mode transition. */
  onModeTransitionResult?: (result: ModeTransitionResult) => void;
  /** Server ACK: it received and applied a MSG_YJS_UPDATE (data is in server RAM). */
  onUpdateReceived?: (fragmentKeys: string[]) => void;
  /** Called after a confirmed session-overlay import with the full payload. */
  onSessionOverlayImported?: (payload: SessionOverlayImportedPayload) => void;
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
        onIdleTimeout: () => {
          this.opts.onIdleTimeout?.();
        },
        onUpdateReceived: (fragmentKeys) => {
          this.store?.markSectionsReceived(fragmentKeys);
          this.opts.onUpdateReceived?.(fragmentKeys);
        },
        onSessionOverlayImported: (payload) => {
          this.store?.forceCleanSections(payload.deletedKeys);
          this.opts.onSessionOverlayImported?.(payload);
        },
        onLocalUpdate: (modifiedFragmentKeys) => {
          if (modifiedFragmentKeys.length > 0) {
            this.store?.markSectionsEdited(modifiedFragmentKeys);
          }
          this.opts.onLocalUpdate?.(modifiedFragmentKeys);
        },
        onSessionReinit: () => {
          this.opts.onSessionReinit?.();
        },
        onDocumentReplacementNotice: (payload) => {
          this.opts.onDocumentReplacementNotice?.(payload);
        },
        onModeTransitionResult: (result) => {
          this.opts.onModeTransitionResult?.(result);
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

  disconnect(): void {
    this.provider.disconnect();
  }

  destroy(): void {
    this.provider.destroy();
    this.store = null;
  }

  focusSection(headingPath: string[]): void {
    this.provider.focusSection(headingPath);
  }

  sendActivityPulse(): void {
    this.provider.sendActivityPulse();
  }

  sendSectionMutate(
    fragmentKey: string,
    markdown: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.provider.sendSectionMutate(fragmentKey, markdown);
  }

  /** Direct access to the wrapped provider. Transitional escape hatch for
   *  callers that still use provider-only surface (focus tracking, etc.). */
  get rawProvider(): CrdtProvider {
    return this.provider;
  }

  /** Pending editor-focus target used by callers that need to know what
   *  heading the next transition will attach to. Delegates to the provider. */
  get pendingEditorFocusTarget(): EditorFocusTarget | null {
    // Provider owns this state but does not expose it — the field is private.
    // Callers that need it should use the mode-controller hook instead.
    return null;
  }
}
