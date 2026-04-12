import { useEffect, useMemo, useRef } from "react";
import type React from "react";
import { DocumentSessionController } from "../controllers/document-session-controller";
import {
  shouldMountEditor,
  type DeletionPlaceholder,
  getSectionFragmentKey,
  type DocumentSection,
} from "../pages/document-page-utils";
import { sectionHeadingKey, type ContentCommittedEvent, type DocumentSessionControllerState, type EditorFocusTarget, type RequestedMode, type RestoreNotificationPayload } from "../types/shared.js";
import type { CrdtConnectionState, CrdtProvider } from "../services/crdt-provider";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { CrdtTransport } from "../services/crdt-transport";
import type { MilkdownEditorHandle } from "../components/MilkdownEditor";
import {
  useSessionMode,
} from "./useSessionMode";
import { useSectionFocus } from "./useSectionFocus";
import { useEditorRegistry } from "./useEditorRegistry";
import { usePersistenceState } from "./usePersistenceState";
import { useProposalDrafting } from "./useProposalDrafting";

export interface UseDocumentSessionControllerParams {
  decodedDocPath: string | null;
  sections: DocumentSection[];
  setSections: React.Dispatch<React.SetStateAction<DocumentSection[]>>;
  setError: (e: string | null) => void;
  setStatusMessage: (s: string | null) => void;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  onRestoreNotification?: (payload: RestoreNotificationPayload) => void;
}

export interface UseDocumentSessionControllerReturn {
  focusedSectionIndex: number | null;
  setFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  crdtProvider: CrdtProvider | null;
  store: BrowserFragmentReplicaStore | null;
  storeRef: React.MutableRefObject<BrowserFragmentReplicaStore | null>;
  transport: CrdtTransport | null;
  crdtSynced: boolean;
  crdtState: CrdtConnectionState;
  crdtError: string | null;
  editingLoading: boolean;
  readyEditors: Set<number>;
  setReadyEditors: React.Dispatch<React.SetStateAction<Set<number>>>;
  deletionPlaceholders: DeletionPlaceholder[];
  setDeletionPlaceholders: React.Dispatch<React.SetStateAction<DeletionPlaceholder[]>>;
  restructuringKeys: Set<string>;
  setRestructuringKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  proposalMode: boolean;
  activeProposalId: string | null;
  controllerState: DocumentSessionControllerState;

  crdtProviderRef: React.MutableRefObject<CrdtProvider | null>;
  controllerStateRef: React.MutableRefObject<DocumentSessionControllerState>;
  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  editorRefs: React.MutableRefObject<Map<number, MilkdownEditorHandle>>;
  pendingFocusRef: React.MutableRefObject<{ index: number; position: "start" | "end"; coords?: { x: number; y: number } } | null>;
  pendingStructureRefocusRef: React.MutableRefObject<string[] | null>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: string; heading_path: string[]; content: string }>>;
  proposalSaveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;

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

  sessionController: DocumentSessionController;
}

function findSectionIndexByFragmentKey(
  sections: DocumentSection[],
  fragmentKey: string,
): number {
  return sections.findIndex((section) => getSectionFragmentKey(section) === fragmentKey);
}

export function useDocumentSessionController(
  params: UseDocumentSessionControllerParams,
): UseDocumentSessionControllerReturn {
  const persistence = usePersistenceState();

  const session = useSessionMode({
    decodedDocPath: params.decodedDocPath,
    sections: params.sections,
    setSections: params.setSections,
    setError: params.setError,
    setStatusMessage: params.setStatusMessage,
    loadSections: params.loadSections,
    onRestoreNotification: params.onRestoreNotification,
    setDeletionPlaceholders: persistence.setDeletionPlaceholders,
    setRestructuringKeys: persistence.setRestructuringKeys,
    onStopEditing: () => {
      focus.setFocusedSectionIndex(null);
      registry.editorRefs.current.clear();
    },
  });

  const storeRef = useRef<BrowserFragmentReplicaStore | null>(null);
  useEffect(() => { storeRef.current = session.store; }, [session.store]);

  const registry = useEditorRegistry({ sections: params.sections });

  const focus = useSectionFocus({
    sections: params.sections,
    crdtProviderRef: session.crdtProviderRef,
    readyEditors: registry.readyEditors,
    editorRefs: registry.editorRefs,
    ensureProvider: session.ensureProvider,
    setControllerState: session.setControllerState,
  });

  useEffect(() => {
    registry.setReadyEditors((prev) => {
      if (focus.focusedSectionIndex === null) return new Set();
      const next = new Set<number>();
      for (const idx of prev) {
        if (shouldMountEditor(idx, focus.focusedSectionIndex)) next.add(idx);
      }
      return next;
    });
  }, [focus.focusedSectionIndex, registry.setReadyEditors]);

  const proposal = useProposalDrafting({
    decodedDocPath: params.decodedDocPath,
    sections: params.sections,
    setError: params.setError,
    loadSections: params.loadSections,
    crdtProviderRef: session.crdtProviderRef,
    setFocusedSectionIndex: focus.setFocusedSectionIndex,
  });

  useEffect(() => {
    return () => {
      if (proposal.proposalSaveTimerRef.current) {
        clearTimeout(proposal.proposalSaveTimerRef.current);
      }
    };
  }, [proposal.proposalSaveTimerRef]);

  const runtime = {
    focusedSectionIndex: focus.focusedSectionIndex,
    setFocusedSectionIndex: focus.setFocusedSectionIndex,
    crdtProvider: session.crdtProvider,
    store: session.store,
    storeRef,
    transport: session.transport,
    crdtSynced: session.crdtSynced,
    crdtState: session.crdtState,
    crdtError: session.crdtError,
    editingLoading: session.editingLoading,
    readyEditors: registry.readyEditors,
    setReadyEditors: registry.setReadyEditors,
    deletionPlaceholders: persistence.deletionPlaceholders,
    setDeletionPlaceholders: persistence.setDeletionPlaceholders,
    restructuringKeys: persistence.restructuringKeys,
    setRestructuringKeys: persistence.setRestructuringKeys,
    proposalMode: proposal.proposalMode,
    activeProposalId: proposal.activeProposalId,
    controllerState: session.controllerState,
    crdtProviderRef: session.crdtProviderRef,
    controllerStateRef: session.controllerStateRef,
    mountedEditorFragmentKeysRef: registry.mountedEditorFragmentKeysRef,
    editorRefs: registry.editorRefs,
    pendingFocusRef: focus.pendingFocusRef,
    pendingStructureRefocusRef: focus.pendingStructureRefocusRef,
    focusedSectionIndexRef: focus.focusedSectionIndexRef,
    proposalSectionsRef: proposal.proposalSectionsRef,
    proposalSaveTimerRef: proposal.proposalSaveTimerRef,
    mouseDownPosRef: focus.mouseDownPosRef,
    ensureProvider: session.ensureProvider,
    stopEditing: session.stopEditing,
    startEditing: focus.startEditing,
    enterProposalMode: proposal.enterProposalMode,
    exitProposalMode: proposal.exitProposalMode,
    saveProposalSections: proposal.saveProposalSections,
    handleProposalSectionChange: proposal.handleProposalSectionChange,
    handleCursorExit: focus.handleCursorExit,
    setEditorRef: registry.setEditorRef,
    setViewingSections: focus.setViewingSections,
    requestMode: session.requestMode,
    stopObserver: session.stopObserver,
  };

  const sessionController = useMemo(() => new DocumentSessionController({
    connectObserver: async () => {
      await runtime.requestMode("observer");
    },
    leaveSession: async () => {
      await runtime.requestMode("none");
    },
    enterEdit: async ({ index, coords }) => {
      await runtime.startEditing(index, coords);
    },
    focusSection: ({ index, headingPath, coords }) => {
      runtime.setFocusedSectionIndex(index);
      runtime.pendingFocusRef.current = { index, position: "start", coords };
      const provider = runtime.crdtProviderRef.current;
      if (provider) {
        provider.focusSection(headingPath);
        runtime.setViewingSections(provider, index);
      }
    },
    moveFocus: (direction) => {
      const focused = runtime.focusedSectionIndexRef.current;
      if (focused == null) return;
      runtime.handleCursorExit(focused, direction);
    },
    importToSessionOverlayNow: () => {
      runtime.crdtProviderRef.current?.sendSessionOverlayImportRequest();
    },
    registerEditor: (fragmentKey, handle) => {
      const idx = findSectionIndexByFragmentKey(params.sections, fragmentKey);
      if (idx >= 0) {
        runtime.setEditorRef(idx, handle);
      }
    },
    markEditorReady: (fragmentKey) => {
      const idx = findSectionIndexByFragmentKey(params.sections, fragmentKey);
      if (idx < 0) return;
      runtime.setReadyEditors((prev) => {
        const next = new Set(prev);
        next.add(idx);
        return next;
      });
    },
    markEditorUnready: (fragmentKey) => {
      const idx = findSectionIndexByFragmentKey(params.sections, fragmentKey);
      if (idx < 0) return;
      runtime.setReadyEditors((prev) => {
        if (!prev.has(idx)) return prev;
        const next = new Set(prev);
        next.delete(idx);
        return next;
      });
    },
    applySectionsRefresh: (sections) => {
      params.setSections(sections);
    },
    handleStructureChanged: (sections) => {
      params.setSections(sections);
    },
    handleCommittedSections: (event: ContentCommittedEvent) => {
      const committedHeadingKeys = new Set(event.sections.map((s) => sectionHeadingKey(s.heading_path)));
      const store = runtime.storeRef.current;
      if (!store) return;
      const fragmentKeys: string[] = [];
      for (const section of params.sections) {
        if (committedHeadingKeys.has(sectionHeadingKey(section.heading_path))) {
          fragmentKeys.push(getSectionFragmentKey(section));
        }
      }
      store.markSectionsClean(fragmentKeys);
    },
  }), [
    params.sections,
    params.setSections,
    runtime.setReadyEditors,
    runtime.startEditing,
    runtime.setFocusedSectionIndex,
    runtime.pendingFocusRef,
    runtime.crdtProviderRef,
    runtime.setViewingSections,
    runtime.focusedSectionIndexRef,
    runtime.handleCursorExit,
    runtime.setEditorRef,
    runtime.requestMode,
  ]);

  return {
    ...runtime,
    sessionController,
  };
}
