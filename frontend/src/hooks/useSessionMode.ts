/**
 * useSessionMode — CrdtProvider + ObserverCrdtProvider lifecycle, mode transitions.
 *
 * Extracted from useDocumentCrdt. Root of the dependency graph — no dependencies
 * on other extracted hooks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { CrdtProvider, type CrdtConnectionState, type StructureWillChangePayload } from "../services/crdt-provider";
import { ObserverCrdtProvider } from "../services/observer-crdt-provider";
import { fragmentToMarkdown } from "../services/fragment-to-markdown";
import {
  type RestoreNotificationPayload,
  type DocumentSessionControllerState,
  type ModeTransitionRequest,
  type ModeTransitionResult,
  type RequestedMode,
  type EditorFocusTarget,
} from "../types/shared.js";
import {
  type DocumentSection,
  type SectionPersistenceState,
  type DeletionPlaceholder,
  getSectionFragmentKey,
} from "../pages/document-page-utils";

// ─── Params ──────────────────────────────────────────────

export interface UseSessionModeParams {
  decodedDocPath: string | null;
  sections: DocumentSection[];
  setSections: React.Dispatch<React.SetStateAction<DocumentSection[]>>;
  setError: (e: string | null) => void;
  setStatusMessage: (s: string | null) => void;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  onRestoreNotification?: (payload: RestoreNotificationPayload) => void;
  // Cross-hook callbacks wired by composition layer
  setSectionPersistence: React.Dispatch<React.SetStateAction<Map<string, SectionPersistenceState>>>;
  setDeletionPlaceholders: React.Dispatch<React.SetStateAction<DeletionPlaceholder[]>>;
  setRestructuringKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  onStopEditing?: () => void;
}

// ─── Return ──────────────────────────────────────────────

export interface UseSessionModeReturn {
  crdtProvider: CrdtProvider | null;
  crdtSynced: boolean;
  crdtState: CrdtConnectionState;
  crdtError: string | null;
  editingLoading: boolean;
  controllerState: DocumentSessionControllerState;
  setControllerState: React.Dispatch<React.SetStateAction<DocumentSessionControllerState>>;
  crdtProviderRef: React.MutableRefObject<CrdtProvider | null>;
  controllerStateRef: React.MutableRefObject<DocumentSessionControllerState>;
  ensureProvider: () => Promise<CrdtProvider | null>;
  stopEditing: () => void;
  requestMode: (mode: RequestedMode, focusTarget?: EditorFocusTarget | null) => Promise<void>;
  stopObserver: () => void;
}

// ─── Hook ────────────────────────────────────────────────

export function useSessionMode({
  decodedDocPath,
  sections,
  setSections,
  setError,
  setStatusMessage,
  loadSections,
  onRestoreNotification,
  setSectionPersistence,
  setDeletionPlaceholders,
  setRestructuringKeys,
  onStopEditing,
}: UseSessionModeParams): UseSessionModeReturn {
  const clientInstanceIdRef = useRef<string>(crypto.randomUUID());

  // ── State ──────────────────────────────────────────────
  const [crdtProvider, setCrdtProvider] = useState<CrdtProvider | null>(null);
  const [crdtSynced, setCrdtSynced] = useState(false);
  const [crdtState, setCrdtState] = useState<CrdtConnectionState>("disconnected");
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
  const crdtProviderRef = useRef<CrdtProvider | null>(null);
  const controllerStateRef = useRef<DocumentSessionControllerState>(controllerState);
  const observerRef = useRef<ObserverCrdtProvider | null>(null);
  const observerDocSessionIdRef = useRef<string | null>(null);
  const stopEditingRef = useRef<(() => void) | null>(null);
  const onStopEditingRef = useRef(onStopEditing);
  onStopEditingRef.current = onStopEditing;

  // ── Ref sync ───────────────────────────────────────────
  useEffect(() => { crdtProviderRef.current = crdtProvider; }, [crdtProvider]);
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
      onStructureWillChange: () => {
        if (docPath) loadSections(docPath);
      },
      onSessionReinit: () => {
        stopEditingRef.current?.();
      },
      onRestoreNotification: (payload) => {
        onRestoreNotification?.(payload);
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
  }, [setSections, loadSections, onRestoreNotification]);

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
      requestId: crypto.randomUUID(),
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
      crdtProviderRef.current?.destroy();
      observerRef.current?.destroy();
    };
  }, []);

  // ── Stop editing ───────────────────────────────────────
  const stopEditing = useCallback(() => {
    if (crdtProviderRef.current) {
      crdtProviderRef.current.destroy();
      setCrdtProvider(null);
      setCrdtSynced(false);
      setCrdtState("disconnected");
    }
    setCrdtError(null);
    setSectionPersistence(new Map());
    setDeletionPlaceholders([]);
    setRestructuringKeys(new Set());
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
        requestId: crypto.randomUUID(),
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
  }, [decodedDocPath, startObserver, applyModeTransitionResult, setSectionPersistence, setDeletionPlaceholders, setRestructuringKeys]);

  useEffect(() => { stopEditingRef.current = stopEditing; }, [stopEditing]);

  // ── Ensure provider ────────────────────────────────────
  const ensureProvider = useCallback(async (): Promise<CrdtProvider | null> => {
    if (!decodedDocPath) return null;
    if (crdtProviderRef.current) return crdtProviderRef.current;

    stopObserver();
    setCrdtError(null);
    setStatusMessage(null);
    setError(null);
    setEditingLoading(true);

    try {
      const doc = new Y.Doc();
      const transition: ModeTransitionRequest = {
        requestId: crypto.randomUUID(),
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
      const provider = new CrdtProvider(doc, decodedDocPath, {
        onStateChange: (state: CrdtConnectionState) => {
          setCrdtState(state);
        },
        onSynced: () => {
          setCrdtSynced(true);
          setEditingLoading(false);
        },
        onError: (reason: string) => setCrdtError(`CRDT sync error: ${reason}`),
        onSessionOverlayImportStarted: () => {
          setSectionPersistence((prev) => {
            const next = new Map(prev);
            for (const [key, state] of next) {
              if (state === "dirty") next.set(key, "pending");
            }
            return next;
          });
        },
        onSessionOverlayImported: ({ writtenKeys, deletedKeys }) => {
          setSectionPersistence((prev) => {
            const next = new Map(prev);
            for (const key of writtenKeys) {
              next.set(key, "flushed");
            }
            for (const key of deletedKeys) {
              next.delete(key);
            }
            return next;
          });
          if (deletedKeys.length > 0) {
            setDeletionPlaceholders((prev) =>
              prev.filter((p) => !deletedKeys.includes(p.fragmentKey)),
            );
          }
        },
        onStructureWillChange: (restructures: StructureWillChangePayload[]) => {
          const keys = new Set<string>();
          for (const r of restructures) {
            keys.add(r.oldKey);
          }
          setRestructuringKeys(keys);
        },
        onLocalUpdate: (modifiedFragmentKeys: string[]) => {
          if (modifiedFragmentKeys.length > 0) {
            setSectionPersistence((prev) => {
              const next = new Map(prev);
              for (const fk of modifiedFragmentKeys) {
                next.set(fk, "dirty");
              }
              return next;
            });
          }
        },
        onSessionReinit: () => {
          stopEditing();
        },
        onRestoreNotification: (payload) => {
          onRestoreNotification?.(payload);
        },
        onModeTransitionResult: applyModeTransitionResult,
        onIdleTimeout: () => {
          stopEditing();
          if (decodedDocPath) {
            loadSections(decodedDocPath);
          }
        },
      }, {
        clientInstanceId: clientInstanceIdRef.current,
        initialTransitionRequest: transition,
      });
      provider.connect();
      setCrdtProvider(provider);
      crdtProviderRef.current = provider;
      return provider;
    } catch (err) {
      setEditingLoading(false);
      setCrdtError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [decodedDocPath, stopEditing, stopObserver, loadSections, setError, setStatusMessage, onRestoreNotification, applyModeTransitionResult, setSectionPersistence, setDeletionPlaceholders, setRestructuringKeys]);

  // ── Request mode ───────────────────────────────────────
  const requestMode = useCallback(async (mode: RequestedMode, focusTarget?: EditorFocusTarget | null): Promise<void> => {
    if (!decodedDocPath) return;
    if (mode === "none") {
      stopObserver();
      if (crdtProviderRef.current) {
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
      if (crdtProviderRef.current) {
        stopEditing();
        return;
      }
      const transition: ModeTransitionRequest = {
        requestId: crypto.randomUUID(),
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
    crdtProvider,
    crdtSynced,
    crdtState,
    crdtError,
    editingLoading,
    controllerState,
    setControllerState,
    crdtProviderRef,
    controllerStateRef,
    ensureProvider,
    stopEditing,
    requestMode,
    stopObserver,
  };
}
