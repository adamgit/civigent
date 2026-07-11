/**
 * useSessionMode — CrdtProvider + ObserverCrdtProvider lifecycle, mode transitions.
 *
 * Extracted from useDocumentCrdt. Root of the dependency graph — no dependencies
 * on other extracted hooks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type CrdtConnectionState } from "../services/crdt-provider";
import { CrdtTransport } from "../services/crdt-transport";
import { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import { LocalPresence } from "../services/local-presence";
import { ObserverCrdtProvider, type ObserverConnectionState } from "../services/observer-crdt-provider";
import { fragmentToMarkdown } from "../services/fragment-to-markdown";
import {
  type DocumentReplacementNoticePayload,
  type DocumentSessionControllerState,
  type ModeTransitionRequest,
  type ModeTransitionResult,
  type RequestedMode,
  type EditorFocusTarget,
} from "../types/shared.js";
import {
  type DocumentSection,
  getSectionFragmentKey,
} from "../pages/document-page-utils";
import { randomUuid } from "../utils/random-uuid";

// ─── Params ──────────────────────────────────────────────

export interface UseSessionModeParams {
  decodedDocPath: string | null;
  sections: DocumentSection[];
  setSections: React.Dispatch<React.SetStateAction<DocumentSection[]>>;
  setError: (e: string | null) => void;
  setStatusMessage: (s: string | null) => void;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
  onStopEditing?: () => void;
}

// ─── Return ──────────────────────────────────────────────

export interface UseSessionModeReturn {
  store: BrowserFragmentReplicaStore | null;
  transport: CrdtTransport | null;
  transportRef: React.MutableRefObject<CrdtTransport | null>;
  presence: LocalPresence | null;
  presenceRef: React.MutableRefObject<LocalPresence | null>;
  crdtSynced: boolean;
  crdtState: CrdtConnectionState;
  observerState: ObserverConnectionState;
  crdtError: string | null;
  editingLoading: boolean;
  controllerState: DocumentSessionControllerState;
  setControllerState: React.Dispatch<React.SetStateAction<DocumentSessionControllerState>>;
  controllerStateRef: React.MutableRefObject<DocumentSessionControllerState>;
  ensureProvider: () => Promise<CrdtTransport | null>;
  stopEditing: () => void;
  requestMode: (mode: RequestedMode, focusTarget?: EditorFocusTarget | null) => Promise<void>;
  stopObserver: () => void;
  /**
   * Stable per-tab client instance id, reused across mode transitions so the
   * CRDT origin socket and the JSON app WebSocket subscription share one
   * routing identity. Passed through to `KnowledgeStoreWsClient.subscribe(...)`
   * so origin-only app events (`section:edit-rejected`) target this exact tab.
   */
  clientInstanceId: string;
}

// ─── Hook ────────────────────────────────────────────────

export function useSessionMode({
  decodedDocPath,
  sections,
  setSections,
  setError,
  setStatusMessage,
  loadSections,
  onDocumentReplacementNotice,
  onStopEditing,
}: UseSessionModeParams): UseSessionModeReturn {
  const clientInstanceIdRef = useRef<string>(randomUuid());

  // ── State ──────────────────────────────────────────────
  const [store, setStore] = useState<BrowserFragmentReplicaStore | null>(null);
  const [transport, setTransport] = useState<CrdtTransport | null>(null);
  const [presence, setPresence] = useState<LocalPresence | null>(null);
  const [crdtSynced, setCrdtSynced] = useState(false);
  const [crdtState, setCrdtState] = useState<CrdtConnectionState>("disconnected");
  // Observer (read-only viewing) connection state — distinct from the editor
  // transport's `crdtState`. Surfaced so a server loss while only VIEWING isn't
  // silently lost: the observer reconnects forever, and the page turns this into
  // a connection banner. "disconnected" means "no observer running" (initial or
  // intentionally stopped), NOT a failure.
  const [observerState, setObserverState] = useState<ObserverConnectionState>("disconnected");
  const [crdtError, setCrdtError] = useState<string | null>(null);
  const [editingLoading, setEditingLoading] = useState(false);
  const [controllerState, setControllerState] = useState<DocumentSessionControllerState>({
    clientInstanceId: clientInstanceIdRef.current,
    requestedMode: "none",
    clientRole: null,
    attachmentState: "detached",
    docSessionId: null,
    editorFocusTarget: null,
    pendingTransition: null,
  });

  // ── Refs ───────────────────────────────────────────────
  const transportRef = useRef<CrdtTransport | null>(null);
  const storeRef = useRef<BrowserFragmentReplicaStore | null>(null);
  const presenceRef = useRef<LocalPresence | null>(null);
  const controllerStateRef = useRef<DocumentSessionControllerState>(controllerState);
  const observerRef = useRef<ObserverCrdtProvider | null>(null);
  const observerDocSessionIdRef = useRef<string | null>(null);
  const stopEditingRef = useRef<(() => void) | null>(null);
  const onStopEditingRef = useRef(onStopEditing);
  onStopEditingRef.current = onStopEditing;

  // ── Ref sync ───────────────────────────────────────────
  useEffect(() => { controllerStateRef.current = controllerState; }, [controllerState]);

  const applyModeTransitionResult = useCallback((result: ModeTransitionResult) => {
    setControllerState((prev) => {
      if (result.clientInstanceId !== prev.clientInstanceId) return prev;
      if (result.kind === "rejected") {
        return {
          ...prev,
          pendingTransition: null,
          attachmentState: result.attachmentState,
          docSessionId: result.docSessionId,
          clientRole: result.clientRole,
        };
      }
      return {
        ...prev,
        requestedMode: result.requestedMode,
        attachmentState: result.attachmentState,
        docSessionId: result.docSessionId,
        clientRole: result.clientRole,
        pendingTransition: null,
      };
    });
  }, []);

  // ── Observer management ────────────────────────────────
  const stopObserver = useCallback(() => {
    if (observerRef.current) {
      observerRef.current.destroy();
      observerRef.current = null;
    }
    // No observer running → not a degraded state, so no banner.
    setObserverState("disconnected");
  }, []);

  const startObserver = useCallback((
    docPath: string,
    opts?: {
      clientInstanceId?: string;
      initialTransitionRequest?: ModeTransitionRequest;
      onModeTransitionResult?: (result: ModeTransitionResult) => void;
    },
  ) => {
    if (observerRef.current) return;
    const observer = new ObserverCrdtProvider(docPath, {
      onStateChange: (state) => setObserverState(state),
      onChange: () => {
        const ydoc = observer.doc;
        setSections((current) => {
          if (current.length === 0) return current;
          let changed = false;
          const updated = current.map((section) => {
            const fk = getSectionFragmentKey(section);
            try {
              const md = fragmentToMarkdown(ydoc, fk);
              if (md !== null && md !== section.content) {
                changed = true;
                return { ...section, content: md };
              }
            } catch {
              // Fragment not yet in Y.Doc — keep existing content
            }
            return section;
          });
          return changed ? updated : current;
        });
      },
      onSessionEnded: () => {
        if (docPath) loadSections(docPath);
      },
      onSessionReinit: () => {
        stopEditingRef.current?.();
      },
      onDocumentReplacementNotice: (payload) => {
        onDocumentReplacementNotice?.(payload);
      },
      onModeTransitionResult: (result) => {
        opts?.onModeTransitionResult?.(result);
      },
    }, {
      clientInstanceId: opts?.clientInstanceId,
      initialTransitionRequest: opts?.initialTransitionRequest,
    });
    observerRef.current = observer;
    observer.connect();
  }, [setSections, loadSections, onDocumentReplacementNotice]);

  // Observer replica safety: recreate when attached session identity changes
  useEffect(() => {
    if (!decodedDocPath) return;
    if (controllerState.requestedMode !== "observer") {
      observerDocSessionIdRef.current = null;
      return;
    }
    const prev = observerDocSessionIdRef.current;
    const next = controllerState.docSessionId;
    const changed = prev !== null && next !== prev;
    const detachedAfterAttach = prev !== null && next === null;
    if (!changed && !detachedAfterAttach) {
      if (prev === null && next) observerDocSessionIdRef.current = next;
      return;
    }
    observerDocSessionIdRef.current = next;
    stopObserver();
    const transition: ModeTransitionRequest = {
      requestId: randomUuid(),
      clientInstanceId: clientInstanceIdRef.current,
      docPath: decodedDocPath,
      requestedMode: "observer",
      editorFocusTarget: null,
    };
    setControllerState((prevState) => ({
      ...prevState,
      pendingTransition: transition,
    }));
    startObserver(decodedDocPath, {
      clientInstanceId: clientInstanceIdRef.current,
      initialTransitionRequest: transition,
      onModeTransitionResult: applyModeTransitionResult,
    });
  }, [controllerState.requestedMode, controllerState.docSessionId, decodedDocPath, stopObserver, startObserver, applyModeTransitionResult]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      storeRef.current?.destroy();
      storeRef.current = null;
      transportRef.current?.destroy();
      transportRef.current = null;
      presenceRef.current = null;
      observerRef.current?.destroy();
    };
  }, []);

  // ── Stop editing ───────────────────────────────────────
  const stopEditing = useCallback(() => {
    if (transportRef.current) {
      storeRef.current?.destroy();
      transportRef.current.destroy();
      storeRef.current = null;
      transportRef.current = null;
      presenceRef.current = null;
      setStore(null);
      setTransport(null);
      setPresence(null);
      setCrdtSynced(false);
      setCrdtState("disconnected");
    }
    setCrdtError(null);
    onStopEditingRef.current?.();
    setControllerState((prev) => ({
      ...prev,
      requestedMode: "none",
      clientRole: null,
      attachmentState: "detached",
      docSessionId: null,
      editorFocusTarget: null,
      pendingTransition: null,
    }));
    // Re-create observer
    if (decodedDocPath) {
      const transition: ModeTransitionRequest = {
        requestId: randomUuid(),
        clientInstanceId: clientInstanceIdRef.current,
        docPath: decodedDocPath,
        requestedMode: "observer",
        editorFocusTarget: null,
      };
      setControllerState((prev) => ({
        ...prev,
        requestedMode: "observer",
        pendingTransition: transition,
      }));
      startObserver(decodedDocPath, {
        clientInstanceId: clientInstanceIdRef.current,
        initialTransitionRequest: transition,
        onModeTransitionResult: applyModeTransitionResult,
      });
    }
  }, [decodedDocPath, startObserver, applyModeTransitionResult]);

  useEffect(() => { stopEditingRef.current = stopEditing; }, [stopEditing]);

  // ── Ensure provider ────────────────────────────────────
  const ensureProvider = useCallback(async (): Promise<CrdtTransport | null> => {
    if (!decodedDocPath) return null;
    if (transportRef.current) return transportRef.current;

    stopObserver();
    setCrdtError(null);
    setStatusMessage(null);
    setError(null);
    setEditingLoading(true);

    try {
      const transition: ModeTransitionRequest = {
        requestId: randomUuid(),
        clientInstanceId: clientInstanceIdRef.current,
        docPath: decodedDocPath,
        requestedMode: "editor",
        editorFocusTarget: null,
      };
      setControllerState((prev) => ({
        ...prev,
        requestedMode: "editor",
        pendingTransition: transition,
      }));
      const nextTransport = new CrdtTransport(decodedDocPath, {
        clientInstanceId: clientInstanceIdRef.current,
        initialTransitionRequest: transition,
        onStateChange: (state: CrdtConnectionState) => {
          setCrdtState(state);
        },
        onSynced: () => {
          setCrdtSynced(true);
          setEditingLoading(false);
        },
        onError: (reason: string) => setCrdtError(`CRDT sync error: ${reason}`),
        onSessionReinit: () => {
          // 4022 document-replaced (restore): the provider reconnects
          // immediately. Reseed canonical so previews reflect restored content.
          if (decodedDocPath) {
            loadSections(decodedDocPath);
          }
        },
        onForceRebuild: () => {
          // 4024 admin force-rebuild: treated like 4022 — the provider
          // reconnects immediately; reseed canonical content.
          if (decodedDocPath) {
            loadSections(decodedDocPath);
          }
        },
        onSuperseded: () => {
          // 4023 superseded_by_new_tab: the same writer opened a newer editor
          // tab that took over the DocSession editor role for this document.
          // Tear down this editor transport and drop back to observer mode
          // instead of reconnecting — reconnecting would supersede the newer
          // tab in return and cause an editor-role ping-pong.
          // Surface a non-error explanation on the page-local status message
          // channel so the user understands the editor session moved, rather
          // than seeing this tab go silently read-only. Real network/auth
          // failures use `setError` / connection-state banners, so this string
          // stays out of those paths.
          setStatusMessage("Editing moved to another tab. This tab is now read-only.");
          stopEditingRef.current?.();
        },
        onDocumentReplacementNotice: (payload) => {
          onDocumentReplacementNotice?.(payload);
        },
        onModeTransitionResult: applyModeTransitionResult,
      });
      const nextStore = new BrowserFragmentReplicaStore(
        nextTransport.doc,
        nextTransport.awareness,
      );
      const nextPresence = new LocalPresence(nextTransport.awareness);
      nextTransport.attachStore(nextStore);
      nextTransport.connect();
      setStore(nextStore);
      setTransport(nextTransport);
      setPresence(nextPresence);
      transportRef.current = nextTransport;
      storeRef.current = nextStore;
      presenceRef.current = nextPresence;
      return nextTransport;
    } catch (err) {
      setEditingLoading(false);
      setCrdtError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [decodedDocPath, stopEditing, stopObserver, loadSections, setError, setStatusMessage, onDocumentReplacementNotice, applyModeTransitionResult]);

  // ── Request mode ───────────────────────────────────────
  const requestMode = useCallback(async (mode: RequestedMode, focusTarget?: EditorFocusTarget | null): Promise<void> => {
    if (!decodedDocPath) return;
    if (mode === "none") {
      stopObserver();
      if (transportRef.current) {
        stopEditing();
      } else {
        setControllerState((prev) => ({
          ...prev,
          requestedMode: "none",
          clientRole: null,
          attachmentState: "detached",
          docSessionId: null,
          editorFocusTarget: null,
          pendingTransition: null,
        }));
      }
      return;
    }
    if (mode === "observer") {
      if (transportRef.current) {
        stopEditing();
        return;
      }
      const transition: ModeTransitionRequest = {
        requestId: randomUuid(),
        clientInstanceId: clientInstanceIdRef.current,
        docPath: decodedDocPath,
        requestedMode: "observer",
        editorFocusTarget: null,
      };
      setControllerState((prev) => ({
        ...prev,
        requestedMode: "observer",
        editorFocusTarget: null,
        pendingTransition: transition,
      }));
      startObserver(decodedDocPath, {
        clientInstanceId: clientInstanceIdRef.current,
        initialTransitionRequest: transition,
        onModeTransitionResult: applyModeTransitionResult,
      });
      return;
    }
    await ensureProvider();
    if (focusTarget) {
      setControllerState((prev) => ({ ...prev, editorFocusTarget: focusTarget }));
    }
  }, [decodedDocPath, stopObserver, stopEditing, startObserver, ensureProvider, applyModeTransitionResult]);

  return {
    store,
    transport,
    transportRef,
    presence,
    presenceRef,
    crdtSynced,
    crdtState,
    observerState,
    crdtError,
    editingLoading,
    controllerState,
    setControllerState,
    controllerStateRef,
    ensureProvider,
    stopEditing,
    requestMode,
    stopObserver,
    clientInstanceId: clientInstanceIdRef.current,
  };
}
