import { useCallback, useEffect, useMemo } from "react";
import type React from "react";
import type { WorkspaceSectionDto } from "../pages/document-page-utils";
import type { ProposalDTO } from "../types/shared.js";
import type { ProposalSectionAvailabilityEvent } from "../types/shared.js";
import type { MilkdownEditorHandle } from "../components/MilkdownEditor";
import { LocalPresence } from "../services/local-presence";
import { SectionId, type RenderSectionRef } from "../types/live-sections";
import type { LiveSectionReplicaView } from "./useLiveSectionReplica";
import { useSectionFocus, type PendingFragmentCaretTarget } from "./useSectionFocus";
import { useEditorRegistry } from "./useEditorRegistry";
import { useProposalDrafting } from "./useProposalDrafting";

export interface UseDocumentSessionControllerParams {
  decodedDocPath: string | null;
  sections: readonly RenderSectionRef[];
  workspaceSections: WorkspaceSectionDto[];
  setError: (e: string | null) => void;
  loadSections: (docPath: string) => Promise<WorkspaceSectionDto[]>;
  liveReplica: LiveSectionReplicaView;
}

export interface UseDocumentSessionControllerReturn {
  bootstrapFocusedSectionIndex: number | null;
  setBootstrapFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
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

  editorRefs: React.MutableRefObject<Map<string, MilkdownEditorHandle>>;
  pendingCaretTargetRef: React.MutableRefObject<PendingFragmentCaretTarget | null>;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: string; heading_path: string[]; content: string }>>;
  proposalSaveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;

  /** Live presence over the replica's awareness (null before mount). */
  presence: LocalPresence | null;
  /** Live-replica-backed block gate for a fragment key. */
  isSectionBlocked: (fragmentKey: string) => boolean;
  /** Live-replica-backed focus gate (blocked / publish pause). */
  canFocusSection: (section: RenderSectionRef | undefined) => boolean;
  /** Broadcast the viewed fragment on the shared awareness (presence). */
  publishViewingSection: (fragmentKey: string) => void;

  startManualPublish: () => Promise<void>;
  enterProposalMode: (proposalId: string) => Promise<void>;
  exitProposalMode: () => Promise<void>;
  acquireProposalLocks: () => Promise<void>;
  commitActiveProposal: () => Promise<void>;
  cancelActiveProposal: () => Promise<void>;
  applyProposalSectionAvailabilityEvent: (event: ProposalSectionAvailabilityEvent) => void;
  updateProposalIntent: (nextIntent: string) => void;
  toggleProposalSection: (target: RenderSectionRef) => Promise<void>;
  removeProposalSection: (docPath: string, headingPath: string[]) => Promise<void>;
  handleProposalSectionChange: (headingPath: readonly string[], markdown: string) => void;
  handleCursorExit: (sectionIndex: number, direction: "up" | "down") => void;
  setEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  setRetargetCaretTarget: (target: Extract<PendingFragmentCaretTarget, { position: "retarget" }>) => void;
}

export function useDocumentSessionController(
  params: UseDocumentSessionControllerParams,
): UseDocumentSessionControllerReturn {
  const { liveReplica } = params;

  const presence = useMemo(
    () => (liveReplica.awareness ? new LocalPresence(liveReplica.awareness) : null),
    [liveReplica.awareness],
  );

  const isSectionBlocked = useCallback((fragmentKey: string): boolean => {
    const replica = liveReplica.replica;
    if (!replica || !replica.isCurrentlyLiveAuthority) return false;
    return replica.isBlocked(SectionId.brand(fragmentKey));
  }, [liveReplica.replica]);

  const canFocusSection = useCallback((section: RenderSectionRef | undefined): boolean => {
    if (liveReplica.publishPaused) return false;
    if (!section) return true; // empty-doc bootstrap (synthetic BFH)
    return !isSectionBlocked(SectionId.text(section.id));
  }, [liveReplica.publishPaused, isSectionBlocked]);

  const publishViewingSection = useCallback((fragmentKey: string) => {
    presence?.setViewingSection(fragmentKey);
  }, [presence]);

  const registry = useEditorRegistry();

  const focus = useSectionFocus({
    sections: params.sections,
    canFocusSection,
    publishViewingSection,
    readyEditors: registry.readyEditors,
    editorRefs: registry.editorRefs,
  });

  // Ready-editor eviction lives on the PAGE (`useEditorWindowEviction`), keyed
  // on the derived focused RENDER index — never on stored focus state here.

  const proposal = useProposalDrafting({
    decodedDocPath: params.decodedDocPath,
    workspaceBaselineSections: params.workspaceSections,
    setError: params.setError,
    loadSections: params.loadSections,
    setBootstrapFocusedSectionIndex: focus.setBootstrapFocusedSectionIndex,
    leaveLiveEditing: liveReplica.demoteToObserver,
  });

  useEffect(() => {
    return () => {
      if (proposal.proposalSaveTimerRef.current) {
        clearTimeout(proposal.proposalSaveTimerRef.current);
      }
    };
  }, [proposal.proposalSaveTimerRef]);

  return {
    bootstrapFocusedSectionIndex: focus.bootstrapFocusedSectionIndex,
    setBootstrapFocusedSectionIndex: focus.setBootstrapFocusedSectionIndex,
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
    editorRefs: registry.editorRefs,
    pendingCaretTargetRef: focus.pendingCaretTargetRef,
    proposalSectionsRef: proposal.proposalSectionsRef,
    proposalSaveTimerRef: proposal.proposalSaveTimerRef,
    mouseDownPosRef: focus.mouseDownPosRef,
    presence,
    isSectionBlocked,
    canFocusSection,
    publishViewingSection,
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
    setRetargetCaretTarget: focus.setRetargetCaretTarget,
  };
}
