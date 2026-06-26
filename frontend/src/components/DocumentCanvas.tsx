import React from "react";
import { DocumentSectionRenderer } from "./DocumentSectionRenderer";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { CrdtTransport } from "../services/crdt-transport";
import type { CrdtConnectionState } from "../services/crdt-provider";
import type { MilkdownEditorHandle } from "./MilkdownEditor";
import type {
  DocumentSection,
} from "../pages/document-page-utils";
import {
  getSectionFragmentKey,
  headingPathToLabel,
  shouldMountEditor,
} from "../pages/document-page-utils";
import { sectionHeadingKey } from "../types/shared.js";
import type { SectionTransfer, SectionTransferService } from "../services/section-transfer";
import type { LocalEditOriginSink } from "../status/sessionAuthorship";
import { SummaryWhoChangedThisSection } from "./SummaryWhoChangedThisSection.js";
import { useSectionEditabilityMap, usePublishPaused } from "../hooks/useFragmentStoreHooks";

export interface DocumentCanvasProps {
  sections: DocumentSection[];
  sectionsLoading: boolean;
  focusedSectionIndex: number | null;
  proposalMode: boolean;
  canEditProposalScope: boolean;
  canEditProposalContent: boolean;
  proposalScopeMutationInFlight: boolean;
  selectedProposalSectionKeys: Set<string>;
  proposalSectionConflicts: Map<string, string>;
  decodedDocPath: string | null;
  recentlyChangedByLabel: Map<string, unknown>;
  injectedByLabel: Map<string, string>;
  dragOverSectionIndex: number | null;
  store: BrowserFragmentReplicaStore | null;
  transport: CrdtTransport | null;
  crdtSynced: boolean;
  crdtState: CrdtConnectionState;
  transferService: SectionTransferService | null;
  readyEditors: Set<string>;
  /** Write-only session-authorship port, passed straight through to each section
   *  renderer. The canvas neither reads nor stores it. */
  localEditSink: LocalEditOriginSink;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  onStartEditing: (index: number, coords: { x: number; y: number }) => void | Promise<void>;
  onFocusSection: (index: number, headingPath: string[], coords: { x: number; y: number }) => void;
  onSetEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  onEditorReady: (fragmentKey: string) => void;
  onEditorUnready: (fragmentKey: string) => void;
  onProposalSectionChange?: (index: number, markdown: string) => void;
  onToggleProposalSection?: (section: DocumentSection) => void | Promise<void>;
  onCursorExit: (index: number, direction: "up" | "down") => void;
  onCrossSectionDrop: (section: DocumentSection, transfer: SectionTransfer) => void;
}

export function DocumentCanvas({
  sections,
  sectionsLoading,
  focusedSectionIndex,
  proposalMode,
  canEditProposalScope,
  canEditProposalContent,
  proposalScopeMutationInFlight,
  selectedProposalSectionKeys,
  proposalSectionConflicts,
  decodedDocPath,
  recentlyChangedByLabel,
  injectedByLabel,
  dragOverSectionIndex,
  store,
  transport,
  crdtSynced,
  crdtState,
  transferService,
  readyEditors,
  localEditSink,
  mouseDownPosRef,
  onStartEditing,
  onFocusSection,
  onSetEditorRef,
  onEditorReady,
  onEditorUnready,
  onProposalSectionChange,
  onToggleProposalSection,
  onCursorExit,
  onCrossSectionDrop,
}: DocumentCanvasProps) {
  // Three independent signals drive editor availability (spec 05 §"Section
  // block-state events" + §"DocSession publish pause messages"):
  //   1. proposal FSM lock conflict (proposalConflictReason / locked)
  //   2. CRDT block-state (blocked → read-only, gone → unmounted)
  //   3. publication pause (freeze all editors)
  // Agent write-policy `canWrite` is NEVER used as a human lock (Area O/Q).
  const editabilityMap = useSectionEditabilityMap(store);
  const publishPaused = usePublishPaused(store);
  return (
    <>
      {!sectionsLoading ? sections.map((section, i) => {
        const sectionKey = sectionHeadingKey(section.heading_path);
        const proposalKey = decodedDocPath ? `${decodedDocPath}::${sectionKey}` : null;
        const isInProposal = !!(proposalMode && proposalKey && selectedProposalSectionKeys.has(proposalKey));
        const proposalConflictReason = proposalKey ? (proposalSectionConflicts.get(proposalKey) ?? null) : null;
        const lockedInProposalMode = proposalMode && isInProposal && proposalConflictReason !== null;
        const fk = getSectionFragmentKey(section);
        const sectionLabel = headingPathToLabel(section.heading_path);
        // CRDT server-driven block-state for this fragment.
        const editability = editabilityMap.get(fk) ?? "editable";
        const crdtBlocked = editability === "blocked";
        const crdtGone = editability === "gone";
        // A `gone` section is unmounted/removed from the canvas entirely.
        if (crdtGone) return null;
        const mountAllowed = proposalMode
          ? (canEditProposalContent && isInProposal && shouldMountEditor(i, focusedSectionIndex))
          : (!crdtBlocked && shouldMountEditor(i, focusedSectionIndex));
        return (
          <div key={fk} className="flex items-stretch">
            {/* Left gutter — who changed this section */}
            <div className="w-[200px] min-w-[100px] shrink relative flex items-stretch justify-end pt-1">
              <SummaryWhoChangedThisSection
                editorId={section.last_editor?.id}
                editorName={section.last_editor?.name}
                secondsAgo={section.last_editor?.seconds_ago}
                writerType={section.last_editor?.type}
                sectionIndex={i}
              />
            </div>

            {/* Center — section content */}
            <div className="flex-1 min-w-[700px] bg-canvas-bg border-x border-[rgba(0,0,0,0.06)] px-14">
              <DocumentSectionRenderer
                section={section}
                index={i}
                fragmentKey={fk}
                isFocused={focusedSectionIndex === i}
                hasEditor={mountAllowed}
                isInProposal={isInProposal}
                proposalConflictReason={proposalConflictReason}
                isLockedByOtherHuman={proposalMode ? lockedInProposalMode : false}
                crdtBlocked={crdtBlocked}
                publishPaused={publishPaused}
                highlightLabel={recentlyChangedByLabel.has(sectionLabel) ? sectionLabel : null}
                injectedByWriter={injectedByLabel.get(sectionLabel) ?? null}
                hasRemotePresence={false}
                dragOverSectionIndex={dragOverSectionIndex}
                store={store}
                transport={transport}
                crdtSynced={crdtSynced}
                crdtState={crdtState}
                transferService={transferService}
                proposalMode={proposalMode}
                canEditProposalContent={canEditProposalContent}
                proposalScopeMutationInFlight={proposalScopeMutationInFlight}
                isReady={readyEditors.has(fk)}
                localEditSink={localEditSink}
                mouseDownPosRef={mouseDownPosRef}
                onStartEditing={onStartEditing}
                onFocusSection={onFocusSection}
                onSetEditorRef={onSetEditorRef}
                onEditorReady={onEditorReady}
                onEditorUnready={onEditorUnready}
                onProposalSectionChange={proposalMode ? onProposalSectionChange : undefined}
                onToggleProposalSection={
                  proposalMode && canEditProposalScope && !proposalScopeMutationInFlight && onToggleProposalSection
                    ? () => onToggleProposalSection(section)
                    : undefined
                }
                onCursorExit={onCursorExit}
                onCrossSectionDrop={onCrossSectionDrop}
              />
            </div>

            {/* Right gutter — empty placeholder */}
            <div className="w-[200px] min-w-[100px] shrink" />
          </div>
        );
      }) : null}
    </>
  );
}

