/**
 * useDocumentSession — owns the per-document lifecycle for the store-based
 * architecture: creates `CrdtTransport`, then `BrowserFragmentReplicaStore`
 * using the transport's Y.Doc + Awareness, and wires them together.
 *
 * The returned store reference is stable for the session's lifetime:
 *   - It is created once per docPath and held in a ref.
 *   - Re-renders of the caller do NOT produce a new store instance.
 *   - `null` is returned until the transport has been fully constructed,
 *     which happens synchronously during the first effect.
 *
 * Teardown:
 *   - `destroy()` is called on both the store and transport when the
 *     session ends (docPath change or unmount).
 *   - Order is: store.destroy() → transport.destroy(). The store's destroy
 *     only clears listeners; the transport's destroy tears down the WS,
 *     the Y.Doc, and the awareness.
 *
 * This hook is a building block for D5 — it replaces the current
 * `CrdtProvider` instantiation pattern in `useSessionMode` / `DocumentPage`.
 * It deliberately does NOT start the WebSocket connection itself: callers
 * must invoke `transport.connect()` when they are ready (e.g. after the
 * session metadata is loaded and a mode transition has been determined).
 */

import { useEffect, useRef, useState } from "react";
import type {
  ClientInstanceId,
  ModeTransitionRequest,
  ModeTransitionResult,
  DocumentReplacementNoticePayload,
} from "../types/shared";
import { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import {
  CrdtTransport,
  type CrdtTransportOptions,
} from "../services/crdt-transport";

export interface UseDocumentSessionOptions {
  /** Stable document path (canonical form, e.g. "/ops/strategy.md"). Passing
   *  null keeps the hook idle (no transport/store). */
  docPath: string | null;
  clientInstanceId?: ClientInstanceId;
  initialTransitionRequest?: ModeTransitionRequest;
  /** Hoisted wire-event callbacks. All optional. The store captures
   *  connection/sync/publication-pause state on its own — these are for callers
   *  that need to react to server-initiated lifecycle transitions. */
  onSessionReinit?: () => void;
  onForceRebuild?: () => void;
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  onModeTransitionResult?: (result: ModeTransitionResult) => void;
}

export interface DocumentSession {
  store: BrowserFragmentReplicaStore;
  transport: CrdtTransport;
}

/**
 * Create and own one `{ store, transport }` pair per docPath.
 * Returns `null` while no docPath is set, or `{ store, transport }` once
 * construction has completed.
 */
export function useDocumentSession(
  opts: UseDocumentSessionOptions,
): DocumentSession | null {
  const {
    docPath,
    clientInstanceId,
    initialTransitionRequest,
    onSessionReinit,
    onForceRebuild,
    onDocumentReplacementNotice,
    onModeTransitionResult,
  } = opts;

  // Callbacks captured via ref so changing their identity across re-renders
  // does not tear down the transport. The transport is bound to the
  // *current* ref value through the thin indirection below.
  const callbacksRef = useRef({
    onSessionReinit,
    onForceRebuild,
    onDocumentReplacementNotice,
    onModeTransitionResult,
  });
  callbacksRef.current = {
    onSessionReinit,
    onForceRebuild,
    onDocumentReplacementNotice,
    onModeTransitionResult,
  };

  const sessionRef = useRef<DocumentSession | null>(null);
  const [session, setSession] = useState<DocumentSession | null>(null);

  useEffect(() => {
    if (!docPath) return;

    const transportOpts: CrdtTransportOptions = {
      clientInstanceId,
      initialTransitionRequest,
      onSessionReinit: () => callbacksRef.current.onSessionReinit?.(),
      onForceRebuild: () => callbacksRef.current.onForceRebuild?.(),
      onDocumentReplacementNotice: (p) => callbacksRef.current.onDocumentReplacementNotice?.(p),
      onModeTransitionResult: (r) => callbacksRef.current.onModeTransitionResult?.(r),
    };

    const transport = new CrdtTransport(docPath, transportOpts);
    const store = new BrowserFragmentReplicaStore(
      transport.doc,
      transport.awareness,
    );
    transport.attachStore(store);

    const pair: DocumentSession = { store, transport };
    sessionRef.current = pair;
    setSession(pair);

    return () => {
      sessionRef.current = null;
      setSession(null);
      store.destroy();
      transport.destroy();
    };
    // docPath is the only lifecycle key — everything else is captured via
    // refs so callback identity changes don't trigger reconstruction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docPath]);

  return session;
}
