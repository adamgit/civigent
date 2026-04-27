import React from "react";
import { DocumentSectionRenderer } from "./DocumentSectionRenderer";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { CrdtTransport } from "../services/crdt-transport";
import type { MilkdownEditorHandle } from "./MilkdownEditor";
import type {
  DeletionPlaceholder,
  DocumentSection,
} from "../pages/document-page-utils";
import {
  getSectionFragmentKey,
  headingPathToLabel,
  shouldMountEditor,
} from "../pages/document-page-utils";
import { sectionHeadingKey } from "../types/shared.js";
import type { SectionTransfer, SectionTransferService } from "../services/section-transfer";
import { SummaryWhoChangedThisSection } from "./SummaryWhoChangedThisSection.js";

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
  presenceIndicators: Array<{ sectionKey: string }>;
  dragOverSectionIndex: number | null;
  store: BrowserFragmentReplicaStore | null;
  transport: CrdtTransport | null;
  crdtSynced: boolean;
  crdtError: string | null;
  transferService: SectionTransferService | null;
  readyEditors: Set<number>;
  deletionPlaceholders: DeletionPlaceholder[];
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  onStartEditing: (index: number, coords: { x: number; y: number }) => void | Promise<void>;
  onFocusSection: (index: number, headingPath: string[], coords: { x: number; y: number }) => void;
  onSetEditorRef: (index: number, handle: MilkdownEditorHandle | null) => void;
  onEditorReady: (index: number) => void;
  onEditorUnready: (index: number) => void;
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
  presenceIndicators,
  dragOverSectionIndex,
  store,
  transport,
  crdtSynced,
  crdtError,
  transferService,
  readyEditors,
  deletionPlaceholders,
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
                hasEditor={
                  proposalMode
                    ? (canEditProposalContent && isInProposal && shouldMountEditor(i, focusedSectionIndex))
                    : shouldMountEditor(i, focusedSectionIndex)
                }
                isInProposal={isInProposal}
                proposalConflictReason={proposalConflictReason}
                isLockedByOtherHuman={proposalMode ? lockedInProposalMode : !!section.blocked}
                highlightLabel={recentlyChangedByLabel.has(sectionLabel) ? sectionLabel : null}
                injectedByWriter={injectedByLabel.get(sectionLabel) ?? null}
                hasRemotePresence={presenceIndicators.some((p) => p.sectionKey === sectionKey)}
                dragOverSectionIndex={dragOverSectionIndex}
                store={store}
                transport={transport}
                crdtSynced={crdtSynced}
                crdtError={crdtError}
                transferService={transferService}
                proposalMode={proposalMode}
                canEditProposalContent={canEditProposalContent}
                proposalScopeMutationInFlight={proposalScopeMutationInFlight}
                isReady={readyEditors.has(i)}
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

      {/* Deletion placeholders */}
      {deletionPlaceholders.map((placeholder) => (
        <div key={`deleting:${placeholder.fragmentKey}`} className="flex">
          <div className="w-[200px] min-w-[100px] shrink" />
          <div className="flex-1 min-w-[700px] bg-canvas-bg border-x border-[rgba(0,0,0,0.06)] px-14">
            <div className="relative m-[-16px] p-[4px_16px] rounded-md border-l-[2.5px] border-l-amber-300 bg-amber-50/30">
              <div className="flex items-center gap-1.5 py-1">
                <span className="w-[5px] h-[5px] rounded-full bg-amber-400" />
                <span className="text-[10px] text-amber-700 line-through">{placeholder.formerHeading || "(before first heading)"}</span>
                <span className="text-[9px] text-amber-500 ml-1">Deletion pending...</span>
              </div>
            </div>
          </div>
          <div className="w-[200px] min-w-[100px] shrink" />
        </div>
      ))}
    </>
  );
}

