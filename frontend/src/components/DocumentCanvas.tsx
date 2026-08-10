import React from "react";
import { DocumentSectionRenderer } from "./DocumentSectionRenderer";
import type { CrdtConnectionState } from "../services/crdt-provider";
import type { MilkdownEditorHandle } from "./MilkdownEditor";
import type { WorkspaceSectionDto } from "../pages/document-page-utils";
import {
  headingPathToLabel,
  shouldMountEditorForFragment,
} from "../pages/document-page-utils";
import { SectionId, type RenderSectionRef } from "../types/live-sections";
import { sectionHeadingKey, type DocPath } from "../types/shared.js";
import type { SectionTransfer, SectionTransferService } from "../services/section-transfer";
import type { LocalEditOriginSink } from "../status/sessionAuthorship";
import { SummaryWhoChangedThisSection } from "./SummaryWhoChangedThisSection.js";

export type SectionLastEditor = NonNullable<WorkspaceSectionDto["last_editor"]>;

export interface DocumentCanvasProps {
  sections: readonly RenderSectionRef[];
  sectionsLoading: boolean;
  focusedFragmentKey: string | null;
  proposalMode: boolean;
  canEditProposalScope: boolean;
  canEditProposalContent: boolean;
  proposalScopeMutationInFlight: boolean;
  selectedProposalSectionKeys: Set<string>;
  proposalSectionConflicts: Map<string, string>;
  docPath: DocPath;
  recentlyChangedByLabel: Map<string, unknown>;
  injectedByLabel: Map<string, string>;
  dragOverFragmentKey: string | null;
  isSectionBlocked: (fragmentKey: string) => boolean;
  publishPaused: boolean;
  crdtState: CrdtConnectionState;
  transferService: SectionTransferService | null;
  readyEditors: Set<string>;
  getDisplayMarkdown: (section: RenderSectionRef) => string;
  getLiveBinding?: (fragmentKey: string) => import("../services/live-section-replica").LiveEditorBinding | undefined;
  getLastEditor?: (fragmentKey: string) => SectionLastEditor | undefined;
  getActiveEditors?: (fragmentKey: string) => string[];
  publishDecision?: import("../types/shared").PublishTriggerDecision | null;
  sectionUncommitted?: (fragmentKey: string) => boolean;
  localEditSink: LocalEditOriginSink;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  onStartEditing: (fragmentKey: string, coords: { x: number; y: number }) => void | Promise<void>;
  onFocusSection: (fragmentKey: string, headingPath: string[], coords: { x: number; y: number }) => void;
  onSetEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  onEditorReady: (fragmentKey: string) => void;
  onEditorUnready: (fragmentKey: string) => void;
  onProposalSectionChange?: (headingPath: readonly string[], markdown: string) => void;
  onToggleProposalSection?: (target: RenderSectionRef) => void | Promise<void>;
  onCursorExit: (fragmentKey: string, direction: "up" | "down") => void;
  onCrossSectionDrop: (target: RenderSectionRef, transfer: SectionTransfer) => void;
}

export function DocumentCanvas({
  sections,
  sectionsLoading,
  focusedFragmentKey,
  proposalMode,
  canEditProposalScope,
  canEditProposalContent,
  proposalScopeMutationInFlight,
  selectedProposalSectionKeys,
  proposalSectionConflicts,
  docPath,
  recentlyChangedByLabel,
  injectedByLabel,
  dragOverFragmentKey,
  isSectionBlocked,
  publishPaused,
  crdtState,
  transferService,
  readyEditors,
  getDisplayMarkdown,
  getLiveBinding,
  getLastEditor,
  getActiveEditors,
  publishDecision = null,
  sectionUncommitted,
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
  const orderedFragmentKeys = sections.map((s) => SectionId.text(s.id));
  return (
    <>
      {!sectionsLoading ? sections.map((section) => {
        const headingPath = [...section.headingPath];
        const sectionKey = sectionHeadingKey(headingPath);
        const proposalKey = `${docPath}::${sectionKey}`;
        const isInProposal = !!(proposalMode && proposalKey && selectedProposalSectionKeys.has(proposalKey));
        const proposalConflictReason = proposalKey ? (proposalSectionConflicts.get(proposalKey) ?? null) : null;
        const lockedInProposalMode = proposalMode && isInProposal && proposalConflictReason !== null;
        const fk = SectionId.text(section.id);
        const sectionLabel = headingPathToLabel(headingPath);
        const crdtBlocked = isSectionBlocked(fk);
        const inMountWindow = shouldMountEditorForFragment(fk, focusedFragmentKey, orderedFragmentKeys);
        const mountAllowed = proposalMode
          ? (canEditProposalContent && isInProposal && inMountWindow)
          : (!crdtBlocked && inMountWindow);
        const lastEditor = getLastEditor?.(fk);
        const activeEditorIds = getActiveEditors?.(fk) ?? [];
        return (
          <div key={fk} className="flex items-stretch">
            <div className="w-[200px] min-w-[100px] shrink relative flex items-stretch justify-end pt-1">
              <SummaryWhoChangedThisSection
                editorId={lastEditor?.id}
                editorName={lastEditor?.name}
                secondsAgo={lastEditor?.seconds_ago}
                writerType={lastEditor?.type}
                fragmentKey={fk}
                activeEditorIds={activeEditorIds}
                publishDecision={publishDecision}
                uncommittedChanges={sectionUncommitted?.(fk) ?? false}
              />
            </div>

            <div className="flex-1 min-w-[700px] bg-canvas-bg border-x border-[rgba(0,0,0,0.06)] px-14">
              <DocumentSectionRenderer
                section={section}
                fragmentKey={fk}
                isFocused={focusedFragmentKey === fk}
                hasEditor={mountAllowed}
                isInProposal={isInProposal}
                proposalConflictReason={proposalConflictReason}
                isLockedByOtherHuman={proposalMode ? lockedInProposalMode : false}
                crdtBlocked={crdtBlocked}
                publishPaused={publishPaused}
                highlightLabel={recentlyChangedByLabel.has(sectionLabel) ? sectionLabel : null}
                injectedByWriter={injectedByLabel.get(sectionLabel) ?? null}
                hasRemotePresence={false}
                dragOverFragmentKey={dragOverFragmentKey}
                crdtState={crdtState}
                transferService={transferService}
                proposalMode={proposalMode}
                canEditProposalContent={canEditProposalContent}
                proposalScopeMutationInFlight={proposalScopeMutationInFlight}
                isReady={readyEditors.has(fk)}
                getDisplayMarkdown={getDisplayMarkdown}
                getLiveBinding={getLiveBinding}
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

            <div className="w-[200px] min-w-[140px] shrink" />
          </div>
        );
      }) : null}
    </>
  );
}
