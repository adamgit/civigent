/**
 * useDocumentSessionController — composition layer for a document page's
 * NON-transport session state: focus, editor registry, and proposal drafting.
 *
 * The live transport (observer/editor sockets, Y.Doc, awareness, publish
 * pause, connection state) is owned exclusively by `useLiveSectionReplica`;
 * this hook only READS the live replica view for editability/pause gates and
 * presence. Proposal drafting remains the separate cold/proposal authority.
 */

import { useCallback, useEffect, useMemo } from "react";
import type React from "react";
import {
  getSectionFragmentKey,
  type DocumentSection,
} from "../pages/document-page-utils";
import type { ProposalDTO } from "../types/shared.js";
import type { ProposalSectionAvailabilityEvent } from "../types/shared.js";
import type { MilkdownEditorHandle } from "../components/MilkdownEditor";
import { LocalPresence } from "../services/local-presence";
import { SectionId } from "../types/live-sections";
import type { LiveSectionReplicaView } from "./useLiveSectionReplica";
import { useSectionFocus, type PendingEditorFocus } from "./useSectionFocus";
import { useEditorRegistry } from "./useEditorRegistry";
import { useProposalDrafting } from "./useProposalDrafting";

export interface UseDocumentSessionControllerParams {
  decodedDocPath: string | null;
  sections: DocumentSection[];
  setError: (e: string | null) => void;
  loadSections: (docPath: string) => Promise<DocumentSection[]>;
  /** The single live transport owner's view (read-only here). */
  liveReplica: LiveSectionReplicaView;
}

export interface UseDocumentSessionControllerReturn {
  focusedSectionIndex: number | null;
  setFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
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

  mountedEditorFragmentKeysRef: React.MutableRefObject<Set<string>>;
  editorRefs: React.MutableRefObject<Map<string, MilkdownEditorHandle>>;
  pendingFocusRef: React.MutableRefObject<PendingEditorFocus | null>;
  pendingStructureRefocusRef: React.MutableRefObject<string[] | null>;
  focusedSectionIndexRef: React.MutableRefObject<number | null>;
  proposalSectionsRef: React.MutableRefObject<Map<string, { doc_path: string; heading_path: string[]; content: string }>>;
  proposalSaveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;

  /** Live presence over the replica's awareness (null before mount). */
  presence: LocalPresence | null;
  /** Live-replica-backed block gate for a fragment key. */
  isSectionBlocked: (fragmentKey: string) => boolean;
  /** Live-replica-backed focus gate (blocked / publish pause). */
  canFocusSection: (section: DocumentSection | undefined) => boolean;
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
  toggleProposalSection: (section: DocumentSection) => Promise<void>;
  removeProposalSection: (docPath: string, headingPath: string[]) => Promise<void>;
  handleProposalSectionChange: (sectionIndex: number, markdown: string) => void;
  handleCursorExit: (sectionIndex: number, direction: "up" | "down") => void;
  setEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  mountEligible: (index: number) => boolean;
  setViewingSection: (sectionIndex: number) => void;
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
    if (!replica || !replica.hasAuthoritativeBootstrap) return false;
    return replica.isBlocked(SectionId.brand(fragmentKey));
  }, [liveReplica.replica]);

  const canFocusSection = useCallback((section: DocumentSection | undefined): boolean => {
    if (liveReplica.publishPaused) return false;
    if (!section) return true; // empty-doc bootstrap (synthetic BFH)
    return !isSectionBlocked(getSectionFragmentKey(section));
  }, [liveReplica.publishPaused, isSectionBlocked]);

  const publishViewingSection = useCallback((fragmentKey: string) => {
    presence?.setViewingSection(fragmentKey);
  }, [presence]);

  const registry = useEditorRegistry({
    sections: params.sections,
    isSectionBlocked,
  });

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
    sections: params.sections,
    setError: params.setError,
    loadSections: params.loadSections,
    setFocusedSectionIndex: focus.setFocusedSectionIndex,
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
    focusedSectionIndex: focus.focusedSectionIndex,
    setFocusedSectionIndex: focus.setFocusedSectionIndex,
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
    mountedEditorFragmentKeysRef: registry.mountedEditorFragmentKeysRef,
    editorRefs: registry.editorRefs,
    pendingFocusRef: focus.pendingFocusRef,
    pendingStructureRefocusRef: focus.pendingStructureRefocusRef,
    focusedSectionIndexRef: focus.focusedSectionIndexRef,
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
    mountEligible: registry.mountEligible,
    setViewingSection: focus.setViewingSection,
  };
}
