import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type {
  ClientInstanceId,
  DocPath,
  ModeTransitionRequest,
  ModeTransitionResult,
  DocumentReplacementNoticePayload,
} from "../types/shared";
import {
  CrdtProvider,
  type CrdtConnectionState,
  type PublishPauseBarrier,
} from "./crdt-provider";

export interface CrdtTransportOptions {
  clientInstanceId?: ClientInstanceId;
  initialTransitionRequest?: ModeTransitionRequest;
  /** Connection-state passthrough. */
  onStateChange?: (state: CrdtConnectionState) => void;
  /** Fired once the live-sections bootstrap has applied. */
  onBootstrapApplied?: () => void;
  /** Error passthrough. */
  onError?: (reason: string) => void;
  /** Fired when a local Y.Doc update is produced. */
  onLocalUpdate?: (modifiedFragmentKeys: string[]) => void;
  /** Receipt watermark changed (Guarantee A). */
  onReceiptChange?: (summary: { allReceived: boolean; pendingFragmentKeys: string[] }) => void;
  /** Called on document replacement (4022) with the server close reason
   *  (`document_replaced` | `stale_doc_session`). The provider does not
   *  reconnect; the consumer must replace the live pipeline in the mode the
   *  reason selects. */
  onSessionReinit?: (reason: string) => void;
  /** Called on admin force-rebuild (4024). Same replacement semantics as 4022. */
  onForceRebuild?: () => void;
  /** Called when the server closes this editor socket with 4023 because a newer
   *  same-writer editor tab superseded this one. Not a reconnect. */
  onSuperseded?: () => void;
  /** Delivered once after onBootstrapApplied on the post-replacement reconnect. */
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  /** Server-authoritative result for this tab's requested CRDT mode transition. */
  onModeTransitionResult?: (result: ModeTransitionResult) => void;
  /** DocSession publish pause started — editors freeze. */
  onPublishPauseStart?: () => void;
  /** DocSession publish pause ended — editors may unfreeze. */
  onPublishPauseEnd?: () => void;
  /** Raw authoritative live-section frame (opcode + payload) — routed into a
   *  `LiveSectionReplica`. */
  onLiveSectionFrame?: (opcode: number, payload: Uint8Array) => void;
  /** Shared Y.Doc to sync into (single-replica promotion reuses the replica's
   *  doc so observer → editor does not mint a new empty document). Omit to mint. */
  doc?: Y.Doc;
  /** Shared awareness paired with `doc` (cursors). Omit to mint. */
  awareness?: Awareness;
}

export class CrdtTransport {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  private provider: CrdtProvider;
  private readonly opts: CrdtTransportOptions;

  constructor(docPath: DocPath, opts: CrdtTransportOptions = {}) {
    this.opts = opts;
    // Reuse the replica's shared doc when provided (single-replica promotion),
    // else mint one (legacy standalone-editor path).
    const doc = opts.doc ?? new Y.Doc();
    this.provider = new CrdtProvider(
      doc,
      docPath,
      {
        onStateChange: (state) => {
          this.opts.onStateChange?.(state);
        },
        onBootstrapApplied: () => {
          this.opts.onBootstrapApplied?.();
        },
        onError: (reason) => {
          this.opts.onError?.(reason);
        },
        onLocalUpdate: (modifiedFragmentKeys) => {
          this.opts.onLocalUpdate?.(modifiedFragmentKeys);
        },
        onReceiptChange: (summary) => {
          this.opts.onReceiptChange?.(summary);
        },
        onSessionReinit: (reason) => {
          this.opts.onSessionReinit?.(reason);
        },
        onForceRebuild: () => {
          this.opts.onForceRebuild?.();
        },
        onSuperseded: () => {
          this.opts.onSuperseded?.();
        },
        onDocumentReplacementNotice: (payload) => {
          this.opts.onDocumentReplacementNotice?.(payload);
        },
        onModeTransitionResult: (result) => {
          this.opts.onModeTransitionResult?.(result);
        },
        onPublishPauseStart: () => {
          this.opts.onPublishPauseStart?.();
        },
        onPublishPauseEnd: () => {
          this.opts.onPublishPauseEnd?.();
        },
        onLiveSectionFrame: (opcode, payload) => {
          this.opts.onLiveSectionFrame?.(opcode, payload);
        },
      },
      {
        clientInstanceId: opts.clientInstanceId,
        initialTransitionRequest: opts.initialTransitionRequest,
        awareness: opts.awareness,
      },
    );
    this.doc = doc;
    this.awareness = this.provider.awareness;
  }

  connect(): void {
    this.provider.connect();
  }

  get state(): CrdtConnectionState {
    return this.provider.state;
  }

  get documentPath(): DocPath {
    return this.provider.documentPath;
  }

  disconnect(): void {
    this.provider.disconnect();
  }

  destroy(): void {
    this.provider.destroy();
  }

  /** Register the editor-freeze barrier used by the publish-pause quiescence
   *  protocol. Delegates to the provider, which owns the barrier. */
  setPublishPauseBarrier(barrier: PublishPauseBarrier | null): void {
    this.provider.setPublishPauseBarrier(barrier);
  }

  flushAndAwaitSync(timeoutMs?: number): Promise<void> {
    return this.provider.flushAndAwaitSync(timeoutMs);
  }
}
