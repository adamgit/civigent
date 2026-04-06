/**
 * useDocumentCrdt — composition layer.
 *
 * Calls the 5 extracted hooks and spreads results into the same
 * UseDocumentCrdtReturn interface. Public interface unchanged.
 *
 * Dependency graph (no circular deps):
 *   useSessionMode ← no hook deps (root)
 *   useSectionFocus ← session
 *   useEditorRegistry ← focus
 *   usePersistenceState ← (none)
 *   useProposalDrafting ← session
 */

import { useEffect } from "react";
import type { RestoreNotificationPayload } from "../types/shared.js";
import type { CrdtConnectionState } from "../services/crdt-provider";
import type { CrdtProvider } from "../services/crdt-provider";
import type { MilkdownEditorHandle } from "../components/MilkdownEditor";
import {
  type SectionPersistenceState,
  type DeletionPlaceholder,
  type DocumentSection,
  shouldMountEditor,
} from "../pages/document-page-utils";
import type {
  DocumentSessionControllerState,
  RequestedMode,
  EditorFocusTarget,
} from "../types/shared.js";

import { useSessionMode } from "./useSessionMode";
import { useSectionFocus } from "./useSectionFocus";
import { useEditorRegistry } from "./useEditorRegistry";
import { usePersistenceState } from "./usePersistenceState";
import { useProposalDrafting } from "./useProposalDrafting";

// ─── Hook parameters ─────────────────────────────────────────────

export interface UseDocumentCrdtParams {
  decodedDocPath: string | null;
  sections: DocumentSection[];
  setSections: React.Dispatch<React.SetStateAction<DocumentSection[]>>;
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
  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  editorRefs: React.MutableRefObject<Map<number, MilkdownEditorHandle>>;
  pendingFocusRef: React.MutableRefObject<{ index: number; position: "start" | "end"; coords?: { x: number; y: number } } | null>;
  pendingStructureRefocusRef: React.MutableRefObject<string[] | null>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: string; heading_path: string[]; content: string }>>;
  proposalSaveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
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
  setError,
  setStatusMessage,
  loadSections,
  onRestoreNotification,
}: UseDocumentCrdtParams): UseDocumentCrdtReturn {
  // 1. Persistence (no deps on other hooks)
  const persistence = usePersistenceState();

  // 2. Session mode (root — takes persistence setters for cross-hook wiring)
  const session = useSessionMode({
    decodedDocPath,
    sections,
    setSections,
    setError,
    setStatusMessage,
    loadSections,
    onRestoreNotification,
    setSectionPersistence: persistence.setSectionPersistence,
    setDeletionPlaceholders: persistence.setDeletionPlaceholders,
    setRestructuringKeys: persistence.setRestructuringKeys,
    onStopEditing: () => {
      // Cross-hook cleanup when editing stops.
      // Safe: focus/registry bindings are initialized before this is ever called.
      focus.setFocusedSectionIndex(null);
      registry.editorRefs.current.clear();
    },
  });

  // 3. Editor registry (no focusedSectionIndex dep — eviction handled below)
  const registry = useEditorRegistry({ sections });

  // 4. Section focus (← session, registry)
  const focus = useSectionFocus({
    sections,
    crdtProviderRef: session.crdtProviderRef,
    readyEditors: registry.readyEditors,
    editorRefs: registry.editorRefs,
    ensureProvider: session.ensureProvider,
    setControllerState: session.setControllerState,
  });

  // Bridge: evict readyEditors entries outside the mount window when focus changes.
  // Lives here because it depends on both focus.focusedSectionIndex and registry.setReadyEditors.
  useEffect(() => {
    registry.setReadyEditors(prev => {
      if (focus.focusedSectionIndex === null) return new Set();
      const next = new Set<number>();
      for (const idx of prev) {
        if (shouldMountEditor(idx, focus.focusedSectionIndex)) next.add(idx);
      }
      return next;
    });
  }, [focus.focusedSectionIndex, registry.setReadyEditors]);

  // 5. Proposal drafting (← session)
  const proposal = useProposalDrafting({
    decodedDocPath,
    sections,
    setError,
    loadSections,
    crdtProviderRef: session.crdtProviderRef,
    setFocusedSectionIndex: focus.setFocusedSectionIndex,
  });

  // Cleanup proposal timer on unmount
  useEffect(() => {
    return () => {
      if (proposal.proposalSaveTimerRef.current) {
        clearTimeout(proposal.proposalSaveTimerRef.current);
      }
    };
  }, [proposal.proposalSaveTimerRef]);

  return {
    // State
    focusedSectionIndex: focus.focusedSectionIndex,
    setFocusedSectionIndex: focus.setFocusedSectionIndex,
    crdtProvider: session.crdtProvider,
    crdtSynced: session.crdtSynced,
    crdtState: session.crdtState,
    crdtError: session.crdtError,
    editingLoading: session.editingLoading,
    readyEditors: registry.readyEditors,
    setReadyEditors: registry.setReadyEditors,
    sectionPersistence: persistence.sectionPersistence,
    setSectionPersistence: persistence.setSectionPersistence,
    deletionPlaceholders: persistence.deletionPlaceholders,
    setDeletionPlaceholders: persistence.setDeletionPlaceholders,
    restructuringKeys: persistence.restructuringKeys,
    setRestructuringKeys: persistence.setRestructuringKeys,
    proposalMode: proposal.proposalMode,
    activeProposalId: proposal.activeProposalId,
    controllerState: session.controllerState,

    // Refs
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
    // Callbacks
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
}
