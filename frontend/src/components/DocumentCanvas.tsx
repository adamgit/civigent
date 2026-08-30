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
  getFragmentVersion: (fragmentKey: string) => number;
  getLiveBinding?: (fragmentKey: string) => import("../services/live-section-replica").LiveEditorBinding | undefined;
  getLastEditor?: (fragmentKey: string) => SectionLastEditor | undefined;
  getActiveEditors?: (fragmentKey: string) => string[];
  publishDecision?: import("../types/shared").PublishTriggerDecision | null;
  sectionUncommitted?: (fragmentKey: string) => boolean;
  localEditSink: LocalEditOriginSink;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  onStartEditing: (fragmentKey: string, coords?: { x: number; y: number }) => void | Promise<void>;
  onFocusSection: (fragmentKey: string, headingPath: string[], coords: { x: number; y: number }) => void;
  onSetEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  onEditorReady: (fragmentKey: string) => void;
  onEditorUnready: (fragmentKey: string) => void;
  onProposalSectionChange?: (headingPath: readonly string[], markdown: string) => void;
  onToggleProposalSection?: (target: RenderSectionRef) => void | Promise<void>;
  onCursorExit: (fragmentKey: string, direction: "up" | "down") => void;
  onDocumentBoundary: (boundary: "start" | "end") => void;
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
  getFragmentVersion,
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
  onDocumentBoundary,
  onCrossSectionDrop,
}: DocumentCanvasProps) {
  const orderedFragmentKeys = sections.map((s) => SectionId.text(s.id));
  const fragmentKeyCounts = new Map<string, number>();
  for (const fragmentKey of orderedFragmentKeys) {
    fragmentKeyCounts.set(fragmentKey, (fragmentKeyCounts.get(fragmentKey) ?? 0) + 1);
  }
  if (sectionsLoading && sections.length === 0) {
    return (
      <div className="flex items-stretch" data-testid="doc-canvas-loading-bones" aria-hidden="true">
        <div className="doc-gutter-left" />
        <div className="doc-paper-col">
          {[0, 1, 2].map((boneGroup) => (
            <div key={boneGroup} className="mb-10">
              <div className="h-5 w-2/5 bg-slate-100 rounded animate-pulse mb-4" />
              <div className="space-y-2">
                <div className="h-3 w-full bg-slate-100 rounded animate-pulse" />
                <div className="h-3 w-11/12 bg-slate-100 rounded animate-pulse" />
                <div className="h-3 w-3/4 bg-slate-100 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
        <div className="doc-gutter-right" />
      </div>
    );
  }
  return (
    <>
      {sections.map((section, sectionIndex) => {
        const headingPath = [...section.headingPath];
        const sectionKey = sectionHeadingKey(headingPath);
        const proposalKey = `${docPath}::${sectionKey}`;
        const isInProposal = !!(proposalMode && proposalKey && selectedProposalSectionKeys.has(proposalKey));
        const proposalConflictReason = proposalKey ? (proposalSectionConflicts.get(proposalKey) ?? null) : null;
        const lockedInProposalMode = proposalMode && isInProposal && proposalConflictReason !== null;
        const fk = SectionId.text(section.id);
        const hasDuplicateIdentity = (fragmentKeyCounts.get(fk) ?? 0) > 1;
        const ownsFragmentIdentity = orderedFragmentKeys.indexOf(fk) === sectionIndex;
        const renderKey = hasDuplicateIdentity ? `${fk}::duplicate-row-${sectionIndex}` : fk;
        const sectionLabel = headingPathToLabel(headingPath);
        const crdtBlocked = isSectionBlocked(fk);
        const inMountWindow = shouldMountEditorForFragment(
          fk,
          focusedFragmentKey,
          orderedFragmentKeys,
          focusedFragmentKey !== null && readyEditors.has(focusedFragmentKey),
        );
        // A corrupt legacy draft can reference one physical fragment from more
        // than one visible row. Mounting the same Y.XmlFragment in both rows makes
        // their refs and selection bindings fight: the last row wins every focus
        // lookup and continuously pulls the caret there. Keep the first physical
        // occurrence as the sole editor owner so the user can rename/remove it
        // and repair the draft. The other occurrence stays visible but static.
        const mountAllowed = ownsFragmentIdentity && (proposalMode
          ? (canEditProposalContent && isInProposal && inMountWindow)
          : (!crdtBlocked && inMountWindow));
        const lastEditor = getLastEditor?.(fk);
        const activeEditorIds = getActiveEditors?.(fk) ?? [];
        return (
          <div key={renderKey} className="flex items-stretch">
            <div className="doc-gutter-left relative flex items-stretch justify-end pt-1">
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

            <div className="doc-paper-col">
              <DocumentSectionRenderer
                section={section}
                fragmentKey={fk}
                isFocused={ownsFragmentIdentity && focusedFragmentKey === fk}
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
                replicaFragmentVersion={getFragmentVersion(fk)}
                getDisplayMarkdown={getDisplayMarkdown}
                getLiveBinding={getLiveBinding}
                localEditSink={localEditSink}
                mouseDownPosRef={mouseDownPosRef}
                onStartEditing={
                  ownsFragmentIdentity
                    ? onStartEditing
                    : (fragmentKey) => onStartEditing(fragmentKey)
                }
                onFocusSection={onFocusSection}
                onSetEditorRef={onSetEditorRef}
                onEditorReady={onEditorReady}
                onEditorUnready={onEditorUnready}
                onProposalSectionChange={proposalMode ? onProposalSectionChange : undefined}
                onToggleProposalSection={
                  proposalMode && canEditProposalScope && !proposalScopeMutationInFlight
                    ? onToggleProposalSection
                    : undefined
                }
                onCursorExit={onCursorExit}
                onDocumentBoundary={onDocumentBoundary}
                onCrossSectionDrop={onCrossSectionDrop}
              />
            </div>

            <div className="doc-gutter-right" />
          </div>
        );
      })}
    </>
  );
}
