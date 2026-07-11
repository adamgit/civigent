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
import type { CrdtConnectionState } from "../services/crdt-provider";
import type { ObserverConnectionState } from "../services/observer-crdt-provider";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { CrdtTransport } from "../services/crdt-transport";
import type { LocalPresence } from "../services/local-presence";
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
  /** Stable per-tab client instance id (forwarded from useSessionMode). */
  clientInstanceId: string;
  focusedSectionIndex: number | null;
  setFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  store: BrowserFragmentReplicaStore | null;
  storeRef: React.MutableRefObject<BrowserFragmentReplicaStore | null>;
  transport: CrdtTransport | null;
  presence: LocalPresence | null;
  crdtSynced: boolean;
  crdtState: CrdtConnectionState;
  observerState: ObserverConnectionState;
  crdtError: string | null;
  editingLoading: boolean;
  readyEditors: Set<string>;
  setReadyEditors: React.Dispatch<React.SetStateAction<Set<string>>>;
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

  transportRef: React.MutableRefObject<CrdtTransport | null>;
  presenceRef: React.MutableRefObject<LocalPresence | null>;
  controllerStateRef: React.MutableRefObject<DocumentSessionControllerState>;
  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  editorRefs: React.MutableRefObject<Map<string, MilkdownEditorHandle>>;
  pendingFocusRef: React.MutableRefObject<{ index: number; position: "start" | "end"; coords?: { x: number; y: number } } | null>;
  pendingStructureRefocusRef: React.MutableRefObject<string[] | null>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: string; heading_path: string[]; content: string }>>;
  proposalSaveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;

  ensureProvider: () => Promise<CrdtTransport | null>;
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
  setEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  mountEligible: (index: number) => boolean;
  setViewingSection: (sectionIndex: number) => void;
  requestMode: (mode: RequestedMode, focusTarget?: EditorFocusTarget | null) => Promise<void>;
  stopObserver: () => void;

  sessionController: DocumentSessionController;
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
    transport: session.transport,
  });

  const focus = useSectionFocus({
    sections: params.sections,
    presenceRef: session.presenceRef,
    storeRef,
    readyEditors: registry.readyEditors,
    editorRefs: registry.editorRefs,
    ensureProvider: session.ensureProvider,
  });

  // Evict ready editors that fall outside the mount window. readyEditors is keyed
  // by fragment_key, so prune by whether each ready fragment key's CURRENT index
  // (resolved against the live section list) is still inside the window. Depending
  // on `params.sections` means this also re-runs after a structural shift, so a
  // ready fragment whose index moved out of the window is correctly evicted.
  useEffect(() => {
    registry.setReadyEditors((prev) => {
      if (prev.size === 0) return prev;
      const focusedIndex = focus.focusedSectionIndex;
      if (focusedIndex === null) return new Set();
      const windowKeys = new Set<string>();
      params.sections.forEach((s, idx) => {
        if (shouldMountEditor(idx, focusedIndex)) {
          windowKeys.add(getSectionFragmentKey(s));
        }
      });
      let changed = false;
      const next = new Set<string>();
      for (const fk of prev) {
        if (windowKeys.has(fk)) next.add(fk);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [focus.focusedSectionIndex, params.sections, registry.setReadyEditors]);

  const proposal = useProposalDrafting({
    decodedDocPath: params.decodedDocPath,
    sections: params.sections,
    setError: params.setError,
    loadSections: params.loadSections,
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
    clientInstanceId: session.clientInstanceId,
    focusedSectionIndex: focus.focusedSectionIndex,
    setFocusedSectionIndex: focus.setFocusedSectionIndex,
    store: session.store,
    storeRef,
    transport: session.transport,
    presence: session.presence,
    crdtSynced: session.crdtSynced,
    crdtState: session.crdtState,
    observerState: session.observerState,
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
    transportRef: session.transportRef,
    presenceRef: session.presenceRef,
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
    setViewingSection: focus.setViewingSection,
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
      if (runtime.presenceRef.current) {
        runtime.setViewingSection(index);
      }
    },
    moveFocus: (direction) => {
      const focused = runtime.focusedSectionIndexRef.current;
      if (focused == null) return;
      runtime.handleCursorExit(focused, direction);
    },
    // Editor registry is keyed by fragment identity end-to-end, so these pass the
    // fragment key straight through — no index translation.
    registerEditor: (fragmentKey, handle) => {
      runtime.setEditorRef(fragmentKey, handle);
    },
    markEditorReady: (fragmentKey) => {
      runtime.setReadyEditors((prev) => {
        if (prev.has(fragmentKey)) return prev;
        const next = new Set(prev);
        next.add(fragmentKey);
        return next;
      });
    },
    markEditorUnready: (fragmentKey) => {
      runtime.setReadyEditors((prev) => {
        if (!prev.has(fragmentKey)) return prev;
        const next = new Set(prev);
        next.delete(fragmentKey);
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
      // Canonical refresh on `content:committed` is handled by
      // useDocumentWebSocket; there is no per-section persistence map to clean.
    },
  }), [
    params.setSections,
    runtime.setReadyEditors,
    runtime.startEditing,
    runtime.setFocusedSectionIndex,
    runtime.pendingFocusRef,
    runtime.presenceRef,
    runtime.setViewingSection,
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
