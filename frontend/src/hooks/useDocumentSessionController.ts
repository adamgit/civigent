import { useEffect, useMemo, useRef } from "react";
import type React from "react";
import { DocumentSessionController } from "../controllers/document-session-controller";
import {
  shouldMountEditor,
  getSectionFragmentKey,
  type DocumentSection,
} from "../pages/document-page-utils";
import { sectionHeadingKey, type ContentCommittedEvent, type DocumentReplacementNoticePayload, type DocumentSessionControllerState, type EditorFocusTarget, type ProposalDTO, type RequestedMode } from "../types/shared.js";
import type { ProposalSectionAvailabilityEvent } from "../types/shared.js";
import type { CrdtConnectionState, CrdtProvider } from "../services/crdt-provider";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { CrdtTransport } from "../services/crdt-transport";
import type { MilkdownEditorHandle } from "../components/MilkdownEditor";
import {
  useSessionMode,
} from "./useSessionMode";
import { useSectionFocus } from "./useSectionFocus";
import { useEditorRegistry } from "./useEditorRegistry";
import { useProposalDrafting } from "./useProposalDrafting";

export interface UseDocumentSessionControllerParams {
  decodedDocPath: string | null;
  sections: DocumentSection[];
  setSections: React.Dispatch<React.SetStateAction<DocumentSection[]>>;
  setError: (e: string | null) => void;
  setStatusMessage: (s: string | null) => void;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  onDocumentReplacementNotice?: (payload: DocumentReplacementNoticePayload) => void;
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
  proposalMode: boolean;
  activeProposalId: string | null;
  activeProposal: ProposalDTO | null;
  activeProposalStatus: ProposalDTO["status"] | null;
  proposalIntent: string;
  canEditProposalScope: boolean;
  creatingProposal: boolean;
  acquiringLocks: boolean;
  publishingProposal: boolean;
  cancellingProposal: boolean;
  proposalScopeMutationInFlight: boolean;
  panelError: string | null;
  selectedProposalSectionKeys: Set<string>;
  proposalSectionConflicts: Map<string, string>;
  proposalOverlayVersion: number;
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
  startManualPublish: () => Promise<void>;
  enterProposalMode: (proposalId: string) => Promise<void>;
  exitProposalMode: () => Promise<void>;
  acquireProposalLocks: () => Promise<void>;
  commitActiveProposal: () => Promise<void>;
  cancelActiveProposal: () => Promise<void>;
  applyProposalSectionAvailabilityEvent: (event: ProposalSectionAvailabilityEvent) => void;
  updateProposalIntent: (nextIntent: string) => void;
  toggleProposalSection: (section: DocumentSection) => Promise<void>;
  removeProposalSection: (docPath: string, headingPath: string[]) => Promise<void>;
  handleProposalSectionChange: (sectionIndex: number, markdown: string) => void;
  handleCursorExit: (sectionIndex: number, direction: "up" | "down") => void;
  setEditorRef: (index: number, handle: MilkdownEditorHandle | null) => void;
  mountEligible: (index: number) => boolean;
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
  const session = useSessionMode({
    decodedDocPath: params.decodedDocPath,
    sections: params.sections,
    setSections: params.setSections,
    setError: params.setError,
    setStatusMessage: params.setStatusMessage,
    loadSections: params.loadSections,
    onDocumentReplacementNotice: params.onDocumentReplacementNotice,
    onStopEditing: () => {
      focus.setFocusedSectionIndex(null);
      registry.editorRefs.current.clear();
    },
  });

  const storeRef = useRef<BrowserFragmentReplicaStore | null>(null);
  useEffect(() => { storeRef.current = session.store; }, [session.store]);

  const registry = useEditorRegistry({
    sections: params.sections,
    store: session.store,
    crdtProvider: session.crdtProvider,
  });

  const focus = useSectionFocus({
    sections: params.sections,
    crdtProviderRef: session.crdtProviderRef,
    storeRef,
    readyEditors: registry.readyEditors,
    editorRefs: registry.editorRefs,
    ensureProvider: session.ensureProvider,
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
    requestMode: session.requestMode,
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
    proposalMode: proposal.proposalMode,
    activeProposalId: proposal.activeProposalId,
    activeProposal: proposal.activeProposal,
    activeProposalStatus: proposal.activeProposalStatus,
    proposalIntent: proposal.proposalIntent,
    canEditProposalScope: proposal.canEditProposalScope,
    creatingProposal: proposal.creatingProposal,
    acquiringLocks: proposal.acquiringLocks,
    publishingProposal: proposal.publishingProposal,
    cancellingProposal: proposal.cancellingProposal,
    proposalScopeMutationInFlight: proposal.proposalScopeMutationInFlight,
    panelError: proposal.panelError,
    selectedProposalSectionKeys: proposal.selectedProposalSectionKeys,
    proposalSectionConflicts: proposal.proposalSectionConflicts,
    proposalOverlayVersion: proposal.proposalOverlayVersion,
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
    startManualPublish: proposal.startManualPublish,
    enterProposalMode: proposal.enterProposalMode,
    exitProposalMode: proposal.exitProposalMode,
    acquireProposalLocks: proposal.acquireProposalLocks,
    commitActiveProposal: proposal.commitActiveProposal,
    cancelActiveProposal: proposal.cancelActiveProposal,
    applyProposalSectionAvailabilityEvent: proposal.applyProposalSectionAvailabilityEvent,
    updateProposalIntent: proposal.updateProposalIntent,
    toggleProposalSection: proposal.toggleProposalSection,
    removeProposalSection: proposal.removeProposalSection,
    handleProposalSectionChange: proposal.handleProposalSectionChange,
    handleCursorExit: focus.handleCursorExit,
    setEditorRef: registry.setEditorRef,
    mountEligible: registry.mountEligible,
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
    focusSection: ({ index, coords }) => {
      // Refuse focus into a blocked/gone section or during a publication pause.
      if (!runtime.mountEligible(index)) return;
      if (runtime.storeRef.current?.getPublishPaused()) return;
      runtime.setFocusedSectionIndex(index);
      runtime.pendingFocusRef.current = { index, position: "start", coords };
      const provider = runtime.crdtProviderRef.current;
      if (provider) {
        runtime.setViewingSections(provider, index);
      }
    },
    moveFocus: (direction) => {
      const focused = runtime.focusedSectionIndexRef.current;
      if (focused == null) return;
      runtime.handleCursorExit(focused, direction);
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
    handleCommittedSections: (_event: ContentCommittedEvent) => {
      // The receipt-driven `markSectionsClean` lifecycle is removed (spec 05
      // §"Content Flush"). Canonical refresh on `content:committed` is handled by
      // useDocumentWebSocket; there is no per-section persistence map to clean.
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
    runtime.mountEligible,
    runtime.storeRef,
    runtime.requestMode,
  ]);

  return {
    ...runtime,
    sessionController,
  };
}
