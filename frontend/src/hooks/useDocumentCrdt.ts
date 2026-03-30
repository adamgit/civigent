import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { apiClient } from "../services/api-client";
import { CrdtProvider, type CrdtConnectionState, type StructureWillChangePayload } from "../services/crdt-provider";
import { ObserverCrdtProvider } from "../services/observer-crdt-provider";
import { fragmentToMarkdown } from "../services/fragment-to-markdown";
import {
  sectionHeadingKey,
  sectionGlobalKey,
  type RestoreNotificationPayload,
  type DocumentSessionControllerState,
  type ModeTransitionRequest,
  type ModeTransitionResult,
  type RequestedMode,
  type EditorFocusTarget,
} from "../types/shared.js";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import {
  type SectionPersistenceState,
  type DeletionPlaceholder,
  type DocumentSection,
  fragmentKeyFromSectionFile,
  shouldMountEditor,
} from "../pages/document-page-utils";

// ─── Hook parameters ─────────────────────────────────────────────

export interface UseDocumentCrdtParams {
  decodedDocPath: string | null;
  sections: DocumentSection[];
  setSections: React.Dispatch<React.SetStateAction<DocumentSection[]>>;
  setSectionsLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setStatusMessage: (s: string | null) => void;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  onRestoreNotification?: (payload: RestoreNotificationPayload) => void;
}

// ─── Hook return type ─────────────────────────────────────────────

export interface UseDocumentCrdtReturn {
  // State
  focusedSectionIndex: number | null;
  setFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  crdtProvider: CrdtProvider | null;
  crdtSynced: boolean;
  crdtState: CrdtConnectionState;
  crdtError: string | null;
  editingLoading: boolean;
  readyEditors: Set<number>;
  setReadyEditors: React.Dispatch<React.SetStateAction<Set<number>>>;
  sectionPersistence: Map<string, SectionPersistenceState>;
  setSectionPersistence: React.Dispatch<React.SetStateAction<Map<string, SectionPersistenceState>>>;
  deletionPlaceholders: DeletionPlaceholder[];
  setDeletionPlaceholders: React.Dispatch<React.SetStateAction<DeletionPlaceholder[]>>;
  restructuringKeys: Set<string>;
  setRestructuringKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  proposalMode: boolean;
  activeProposalId: string | null;
  controllerState: DocumentSessionControllerState;

  // Refs
  crdtProviderRef: React.MutableRefObject<CrdtProvider | null>;
  controllerStateRef: React.MutableRefObject<DocumentSessionControllerState>;
  /** Fragment keys of sections that currently have a mounted Milkdown editor. */
  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  editorRefs: React.MutableRefObject<Map<number, MilkdownEditorHandle>>;
  pendingFocusRef: React.MutableRefObject<{ index: number; position: "start" | "end"; coords?: { x: number; y: number } } | null>;
  pendingStructureRefocusRef: React.MutableRefObject<string[] | null>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: string; heading_path: string[]; content: string }>>;
  proposalSaveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  deferredEditIndexRef: React.MutableRefObject<number | null>;

  // Callbacks
  ensureProvider: () => Promise<CrdtProvider | null>;
  stopEditing: () => void;
  startEditing: (sectionIndex: number, clickCoords?: { x: number; y: number }) => Promise<void>;
  enterProposalMode: (proposalId: string) => Promise<void>;
  exitProposalMode: () => void;
  saveProposalSections: () => void;
  handleProposalSectionChange: (sectionIndex: number, markdown: string) => void;
  handleCursorExit: (sectionIndex: number, direction: "up" | "down") => void;
  setEditorRef: (index: number, handle: MilkdownEditorHandle | null) => void;
  setViewingSections: (provider: CrdtProvider, sectionIndex: number) => void;
  requestMode: (mode: RequestedMode, focusTarget?: EditorFocusTarget | null) => Promise<void>;
  stopObserver: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────

export function useDocumentCrdt({
  decodedDocPath,
  sections,
  setSections,
  setSectionsLoading,
  setError,
  setStatusMessage,
  loadSections,
  onRestoreNotification,
}: UseDocumentCrdtParams): UseDocumentCrdtReturn {
  const clientInstanceIdRef = useRef<string>(crypto.randomUUID());

  // ── State ─────────────────────────────────────────────────
  const [focusedSectionIndex, setFocusedSectionIndex] = useState<number | null>(null);
  const [crdtProvider, setCrdtProvider] = useState<CrdtProvider | null>(null);
  const [crdtSynced, setCrdtSynced] = useState(false);
  const [crdtState, setCrdtState] = useState<CrdtConnectionState>("disconnected");
  const [crdtError, setCrdtError] = useState<string | null>(null);
  const [editingLoading, setEditingLoading] = useState(false);
  const [readyEditors, setReadyEditors] = useState<Set<number>>(new Set());
  const [sectionPersistence, setSectionPersistence] = useState<Map<string, SectionPersistenceState>>(new Map());
  const [deletionPlaceholders, setDeletionPlaceholders] = useState<DeletionPlaceholder[]>([]);
  const [restructuringKeys, setRestructuringKeys] = useState<Set<string>>(new Set());
  const [proposalMode, setProposalMode] = useState(false);
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  const [controllerState, setControllerState] = useState<DocumentSessionControllerState>({
    clientInstanceId: clientInstanceIdRef.current,
    requestedMode: "none",
    clientRole: null,
    attachmentState: "detached",
    docSessionId: null,
    editorFocusTarget: null,
    pendingTransition: null,
  });

  // ── Refs ──────────────────────────────────────────────────
  const crdtProviderRef = useRef<CrdtProvider | null>(null);
  // controllerStateRef: always reflects the latest controllerState without
  // being a closure dep. Use this inside async callbacks / effects where
  // adding controllerState to deps would cause unwanted re-runs.
  const controllerStateRef = useRef<DocumentSessionControllerState>(controllerState);
  // mountedEditorFragmentKeysRef: updated whenever editors mount or unmount.
  // Provides identity-based CRDT-bound exclusion for section refresh logic
  // (replacing the fragile focused-index ±1 positional heuristic).
  const mountedEditorFragmentKeysRef = useRef<Set<string>>(new Set());
  const observerRef = useRef<ObserverCrdtProvider | null>(null);
  const editorRefs = useRef<Map<number, MilkdownEditorHandle>>(new Map());
  const pendingFocusRef = useRef<{ index: number; position: "start" | "end"; coords?: { x: number; y: number } } | null>(null);
  const pendingStructureRefocusRef = useRef<string[] | null>(null);
  const focusedSectionIndexRef = useRef<number | null>(null);
  const sectionsRef = useRef<DocumentSection[]>([]);
  const proposalSectionsRef = useRef<Map<string, { doc_path: string; heading_path: string[]; content: string }>>(new Map());
  const proposalSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const deferredEditIndexRef = useRef<number | null>(null);
  const deferredClickCoordsRef = useRef<{ x: number; y: number } | null>(null);
  const observerDocSessionIdRef = useRef<string | null>(null);
  // Stable ref to stopEditing, used in observer's onSessionReinit to break circular dep.
  const stopEditingRef = useRef<(() => void) | null>(null);

  // ── Ref sync effects ──────────────────────────────────────
  useEffect(() => {
    crdtProviderRef.current = crdtProvider;
  }, [crdtProvider]);

  useEffect(() => {
    controllerStateRef.current = controllerState;
  }, [controllerState]);

  useEffect(() => {
    // B4: clear any stale pendingFocusRef when editing stops so it cannot
    // fire focus into the wrong section on a later successful navigation.
    if (focusedSectionIndex === null) pendingFocusRef.current = null;
    focusedSectionIndexRef.current = focusedSectionIndex;
    // B1: evict only the entries that fall outside the mount window.
    // Previously the entire Set was cleared (causing overlap corruption for
    // sections still inside the ±1 window) or only the focused index was
    // deleted (stale entries for evicted sections caused blank-flash on remount).
    setReadyEditors(prev => {
      if (focusedSectionIndex === null) return new Set();
      const next = new Set<number>();
      for (const idx of prev) {
        if (shouldMountEditor(idx, focusedSectionIndex)) next.add(idx);
      }
      return next;
    });
  }, [focusedSectionIndex]);

  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

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

  // ── Internal observer management ──────────────────────────
  // Observer creation lives here so pages don't construct providers directly.

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
    if (observerRef.current) return; // already observing
    const observer = new ObserverCrdtProvider(docPath, {
      onChange: () => {
        // Functional updater avoids stale-closure overwrite: if a content:committed
        // event triggers setSections(freshSections) before the next render updates
        // sectionsRef, using sectionsRef.current here would overwrite the fresh data.
        const ydoc = observer.doc;
        setSections((current) => {
          if (current.length === 0) return current;
          let changed = false;
          const updated = current.map((section) => {
            const fk = fragmentKeyFromSectionFile(section.section_file, section.heading_path.length === 0);
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
        // Editing session ended — fall back to REST content
        if (docPath) loadSections(docPath);
        // Observer auto-reconnects to wait for next session
      },
      onStructureWillChange: () => {
        // Structure changed — reload sections from REST to get new skeleton
        if (docPath) loadSections(docPath);
      },
      onSessionReinit: () => {
        // Document restored (close code 4022) — exit edit mode
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

  // Observer replica safety: observer Y.Doc is scoped to one DocSessionId.
  // Recreate when attached session identity changes, or when it becomes null after attach.
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

  // ── Provider cleanup on unmount ────────────────────────────
  useEffect(() => {
    return () => {
      crdtProviderRef.current?.destroy();
      observerRef.current?.destroy();
      if (proposalSaveTimerRef.current) {
        clearTimeout(proposalSaveTimerRef.current);
      }
    };
  }, []);

  // ── Stop editing helper ────────────────────────────────────
  const stopEditing = useCallback(() => {
    if (crdtProviderRef.current) {
      crdtProviderRef.current.destroy();
      setCrdtProvider(null);
      setCrdtSynced(false);
      setCrdtState("disconnected");
    }
    setFocusedSectionIndex(null);
    setCrdtError(null);
    setSectionPersistence(new Map());
    setDeletionPlaceholders([]);
    setRestructuringKeys(new Set());
    editorRefs.current.clear();
    pendingFocusRef.current = null;
    setControllerState((prev) => ({
      ...prev,
      requestedMode: "none",
      clientRole: null,
      attachmentState: "detached",
      docSessionId: null,
      editorFocusTarget: null,
      pendingTransition: null,
    }));
    // Re-create observer to resume passive live sync
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
  }, [decodedDocPath, startObserver, applyModeTransitionResult]);

  // Keep stopEditingRef in sync so the observer's onSessionReinit can call it
  // without a circular dependency through startObserver.
  useEffect(() => {
    stopEditingRef.current = stopEditing;
  }, [stopEditing]);

  // ── Proposal mode enter/exit ───────────────────────────────
  const enterProposalMode = useCallback(async (proposalId: string) => {
    // Disconnect CRDT (if connected) to exit collaborative editing
    if (crdtProviderRef.current) {
      crdtProviderRef.current.disconnect();
    }
    setProposalMode(true);
    setActiveProposalId(proposalId);
    setFocusedSectionIndex(null);
  }, []);

  const exitProposalMode = useCallback(() => {
    // Cancel any pending save
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
      proposalSaveTimerRef.current = null;
    }
    proposalSectionsRef.current.clear();
    setProposalMode(false);
    setActiveProposalId(null);
    // Reconnect CRDT if provider still exists
    if (crdtProviderRef.current) {
      crdtProviderRef.current.connect();
    }
    // Reload sections to get fresh canonical content
    if (decodedDocPath) {
      loadSections(decodedDocPath);
    }
  }, [decodedDocPath, loadSections]);

  /** Debounced save of proposal sections to backend (~2s after last edit). */
  const saveProposalSections = useCallback(() => {
    if (proposalSaveTimerRef.current) {
      clearTimeout(proposalSaveTimerRef.current);
    }
    proposalSaveTimerRef.current = setTimeout(async () => {
      proposalSaveTimerRef.current = null;
      const proposalId = activeProposalId;
      if (!proposalId) return;
      const sectionsList = [...proposalSectionsRef.current.values()];
      if (sectionsList.length === 0) return;
      try {
        await apiClient.updateProposal(proposalId, { sections: sectionsList });
      } catch (err) {
        setError(`Failed to save proposal: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 2000);
  }, [activeProposalId, setError]);

  /** Called when a section is edited in proposal mode. Auto-adds the section to the proposal. */
  const handleProposalSectionChange = useCallback((sectionIndex: number, markdown: string) => {
    const section = sections[sectionIndex];
    if (!section || !decodedDocPath) return;
    const key = sectionGlobalKey(decodedDocPath, section.heading_path);
    proposalSectionsRef.current.set(key, {
      doc_path: decodedDocPath,
      heading_path: section.heading_path,
      content: markdown,
    });
    saveProposalSections();
  }, [sections, decodedDocPath, saveProposalSections]);

  // ── Enter edit mode: create one provider per document ──────
  const ensureProvider = useCallback(async (): Promise<CrdtProvider | null> => {
    if (!decodedDocPath) return null;

    // Already have an active provider for this document
    if (crdtProviderRef.current) return crdtProviderRef.current;

    // Destroy observer — the full CrdtProvider takes over
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
          // Y.Doc now has server state — apply deferred focus if pending
          const deferredIdx = deferredEditIndexRef.current;
          if (deferredIdx !== null) {
            const coords = deferredClickCoordsRef.current;
            deferredEditIndexRef.current = null;
            deferredClickCoordsRef.current = null;
            setFocusedSectionIndex(deferredIdx);
            pendingFocusRef.current = { index: deferredIdx, position: "start", coords: coords ?? undefined };
          }
        },
        onError: (reason: string) => setCrdtError(`CRDT sync error: ${reason}`),
        onFlushStarted: () => {
          // All dirty sections → pending
          setSectionPersistence((prev) => {
            const next = new Map(prev);
            for (const [key, state] of next) {
              if (state === "dirty") next.set(key, "pending");
            }
            return next;
          });
        },
        onSessionFlushed: ({ writtenKeys, deletedKeys }) => {
          setSectionPersistence((prev) => {
            const next = new Map(prev);
            // Written keys → flushed (even if client didn't track them as dirty)
            for (const key of writtenKeys) {
              next.set(key, "flushed");
            }
            // Deleted keys → remove from map (placeholder handles UI)
            for (const key of deletedKeys) {
              next.delete(key);
            }
            return next;
          });
          // Resolve deletion placeholders for confirmed-deleted keys
          if (deletedKeys.length > 0) {
            setDeletionPlaceholders((prev) =>
              prev.filter((p) => !deletedKeys.includes(p.fragmentKey)),
            );
          }
        },
        onStructureWillChange: (restructures: StructureWillChangePayload[]) => {
          // Suppress rendering for fragments about to be restructured.
          // The Y.Doc mutation (clear + repopulate) will follow immediately.
          // Without this, the user sees empty/broken content between clear and repopulate.
          const keys = new Set<string>();
          for (const r of restructures) {
            keys.add(r.oldKey);
          }
          setRestructuringKeys(keys);
        },
        onLocalUpdate: (modifiedFragmentKeys: string[]) => {
          // Mark actually-modified fragments as dirty (decoupled from focusedSectionIndex)
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
      setEditingLoading(false);
      return provider;
    } catch (err) {
      setEditingLoading(false);
      setCrdtError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [decodedDocPath, stopEditing, stopObserver, loadSections, setError, setStatusMessage, onRestoreNotification, applyModeTransitionResult]);

  // ── viewingPresence: set Awareness viewingSections on focus change ──
  const setViewingSections = useCallback((provider: CrdtProvider, sectionIndex: number) => {
    const section = sections[sectionIndex];
    if (!section) return;
    const fk = fragmentKeyFromSectionFile(section.section_file, section.heading_path.length === 0);
    // viewingPresence: client-informational, cosmetic UI only.
    // Signal source is editor focus for now; can be swapped to
    // IntersectionObserver without touching backend.
    const currentUser = provider.awareness.getLocalState()?.user;
    provider.awareness.setLocalStateField("user", {
      ...currentUser,
      viewingSections: [fk],
    });
  }, [sections]);

  // ── Click-to-edit a section ─────────────────────────────────
  const startEditing = useCallback(async (sectionIndex: number, clickCoords?: { x: number; y: number }) => {
    const hadProvider = !!crdtProviderRef.current;
    const provider = await ensureProvider();
    if (!provider) return;

    if (hadProvider) {
      // Existing provider — Y.Doc already has content, focus immediately
      setFocusedSectionIndex(sectionIndex);
      pendingFocusRef.current = { index: sectionIndex, position: "start", coords: clickCoords };
    } else {
      // New provider — defer focus until onSynced fires (Y.Doc is empty until then)
      deferredEditIndexRef.current = sectionIndex;
      deferredClickCoordsRef.current = clickCoords ?? null;
    }

    // Notify server of section focus (editingPresence)
    const section = sections[sectionIndex];
    if (section) {
      provider.focusSection(section.heading_path);
      setControllerState((prev) => ({
        ...prev,
        editorFocusTarget: section.heading_path.length > 0
          ? { kind: "heading_path", heading_path: section.heading_path }
          : { kind: "before_first_heading" },
      }));
    }
    setViewingSections(provider, sectionIndex);
  }, [ensureProvider, sections, setViewingSections]);

  // ── Cross-section cursor navigation ──────────────────────────
  const handleCursorExit = useCallback((sectionIndex: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? sectionIndex - 1 : sectionIndex + 1;
    if (targetIndex < 0 || targetIndex >= sections.length) return;

    setFocusedSectionIndex(targetIndex);
    pendingFocusRef.current = {
      index: targetIndex,
      position: direction === "up" ? "end" : "start",
    };

    // Notify server of section focus change (editingPresence)
    const provider = crdtProviderRef.current;
    const targetSection = sections[targetIndex];
    if (provider && targetSection) {
      provider.focusSection(targetSection.heading_path);
      setControllerState((prev) => ({
        ...prev,
        editorFocusTarget: targetSection.heading_path.length > 0
          ? { kind: "heading_path", heading_path: targetSection.heading_path }
          : { kind: "before_first_heading" },
      }));
    }
    // viewingPresence: broadcast which section we're viewing
    if (provider) {
      setViewingSections(provider, targetIndex);
    }
  }, [sections, setViewingSections]);

  // ── Focus editor after it is ready AND visible ──────────────
  // Deferred until readyEditors includes the target index, so
  // posAtCoords has rendered text to work with.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const { index, position, coords } = pendingFocusRef.current;
    if (!readyEditors.has(index)) return;

    // One frame after visibility swap so the browser has painted the editor
    const raf = requestAnimationFrame(() => {
      const handle = editorRefs.current.get(index);
      if (handle) {
        if (coords) {
          handle.focusAtCoords(coords.x, coords.y);
        } else {
          handle.focus(position);
        }
      }
      pendingFocusRef.current = null;
    });

    return () => cancelAnimationFrame(raf);
  }, [focusedSectionIndex, readyEditors]);

  // ── Restore focus after doc_structure:changed re-fetches sections ──
  useEffect(() => {
    const refocusPath = pendingStructureRefocusRef.current;
    if (!refocusPath || !crdtProviderRef.current) return;
    pendingStructureRefocusRef.current = null;

    // Find the section whose heading path matches the old focus.
    // After a split, the original heading is still the first fragment,
    // so exact match should work.
    const exactIdx = sections.findIndex(
      (s) => sectionHeadingKey(s.heading_path) === sectionHeadingKey(refocusPath),
    );

    if (exactIdx >= 0) {
      setFocusedSectionIndex(exactIdx);
      pendingFocusRef.current = { index: exactIdx, position: "end" };
      crdtProviderRef.current.focusSection(sections[exactIdx].heading_path);
    } else {
      // Heading was renamed or removed — drop focus (user knows where they are)
      setFocusedSectionIndex(null);
    }
  }, [sections]);

  // ── Editor ref callback ──────────────────────────────────────
  const setEditorRef = useCallback((index: number, handle: MilkdownEditorHandle | null) => {
    if (handle) {
      editorRefs.current.set(index, handle);
    } else {
      editorRefs.current.delete(index);
    }
    // Keep mountedEditorFragmentKeysRef in sync for identity-based CRDT exclusion.
    const mounted = new Set<string>();
    for (const i of editorRefs.current.keys()) {
      const s = sectionsRef.current[i];
      if (s) {
        mounted.add(fragmentKeyFromSectionFile(s.section_file, s.heading_path.length === 0));
      }
    }
    mountedEditorFragmentKeysRef.current = mounted;
  }, []);

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
    // State
    focusedSectionIndex,
    setFocusedSectionIndex,
    crdtProvider,
    crdtSynced,
    crdtState,
    crdtError,
    editingLoading,
    readyEditors,
    setReadyEditors,
    sectionPersistence,
    setSectionPersistence,
    deletionPlaceholders,
    setDeletionPlaceholders,
    restructuringKeys,
    setRestructuringKeys,
    proposalMode,
    activeProposalId,
    controllerState,

    // Refs
    crdtProviderRef,
    controllerStateRef,
    mountedEditorFragmentKeysRef,
    editorRefs,
    pendingFocusRef,
    pendingStructureRefocusRef,
    focusedSectionIndexRef,
    proposalSectionsRef,
    proposalSaveTimerRef,
    mouseDownPosRef,
    deferredEditIndexRef,

    // Callbacks
    ensureProvider,
    stopEditing,
    startEditing,
    enterProposalMode,
    exitProposalMode,
    saveProposalSections,
    handleProposalSectionChange,
    handleCursorExit,
    setEditorRef,
    setViewingSections,
    requestMode,
    stopObserver,
  };
}
