import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MilkdownEditor, type MilkdownEditorHandle } from "./MilkdownEditor";
import type { CrdtProvider } from "../services/crdt-provider";
import type { SectionPersistenceState, DocumentSection } from "../pages/document-page-utils";
import { headingPathToLabel, fragmentKeyFromSectionFile } from "../pages/document-page-utils";
import { resolveWriterId } from "../services/api-client";
import type { SectionTransfer } from "../services/section-transfer";
import { useSectionHover } from "../contexts/sectionHoverUtils";

export interface DocumentSectionRendererProps {
  section: DocumentSection;
  index: number;
  fragmentKey: string;
  isFocused: boolean;
  hasEditor: boolean;
  isRestructuring: boolean;
  isInProposal: boolean;
  isLockedByOtherHuman: boolean;
  highlightLabel: string | null;
  injectedByWriter: string | null;
  hasRemotePresence: boolean;
  dragOverSectionIndex: number | null;
  crdtProvider: CrdtProvider | null;
  crdtError: string | null;
  proposalMode: boolean;
  isReady: boolean;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  onStartEditing: (index: number, coords: { x: number; y: number }) => void;
  onFocusSection: (index: number, headingPath: string[], coords: { x: number; y: number }) => void;
  onSetEditorRef: (index: number, handle: MilkdownEditorHandle | null) => void;
  onEditorReady: (index: number) => void;
  onProposalSectionChange?: (index: number, markdown: string) => void;
  onCursorExit: (index: number, direction: "up" | "down") => void;
  onCrossSectionDrop: (section: DocumentSection, transfer: SectionTransfer) => void;
}

export function DocumentSectionRenderer({
  section,
  index: i,
  fragmentKey: fk,
  isFocused,
  hasEditor,
  isRestructuring,
  isInProposal,
  isLockedByOtherHuman,
  highlightLabel,
  injectedByWriter,
  hasRemotePresence,
  dragOverSectionIndex,
  crdtProvider,
  crdtError,
  proposalMode,
  isReady,
  mouseDownPosRef,
  onStartEditing,
  onFocusSection,
  onSetEditorRef,
  onEditorReady,
  onProposalSectionChange,
  onCursorExit,
  onCrossSectionDrop,
}: DocumentSectionRendererProps) {
  const { setHoveredSection } = useSectionHover();
  return (
    <div
      key={fk}
      data-section-index={i}
      data-fragment-key={fk}
      data-heading-path={JSON.stringify(section.heading_path)}
      className={`relative mx-[-16px] px-[16px] rounded-md border-l-[2.5px] transition-all group ${
        isLockedByOtherHuman
          ? `bg-amber-50/50 border-l-amber-400 opacity-75`
          : isInProposal
          ? `bg-blue-50/30 border-l-blue-500`
          : highlightLabel
          ? `bg-green-50/70 border-l-green-400 cursor-pointer hover:bg-section-hover`
          : isFocused
          ? `cursor-pointer hover:bg-section-hover border-l-accent-emphasis`
          : hasRemotePresence
          ? `cursor-pointer hover:bg-section-hover border-l-blue-400`
          : `cursor-pointer hover:bg-section-hover border-l-transparent`
      }${dragOverSectionIndex === i ? " section-drop-target" : ""}${injectedByWriter ? " section-injected-flash" : ""}`}
      onMouseEnter={() => setHoveredSection(i)}
      onMouseLeave={() => setHoveredSection(null)}
      onMouseDown={(e) => { mouseDownPosRef.current = { x: e.clientX, y: e.clientY }; }}
      onClick={isLockedByOtherHuman ? undefined : hasEditor ? undefined : (e) => {
        const down = mouseDownPosRef.current;
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
        void onStartEditing(i, { x: e.clientX, y: e.clientY });
      }}
    >
      {/* Injection attribution — fading right-gutter message when a proposal injected this section */}
      {injectedByWriter ? (
        <span className="section-injected-msg">
          Updated by {injectedByWriter}
        </span>
      ) : null}

      {/* Section body: editor or static preview */}
      {isRestructuring ? (
        <div className="py-3">
          <div className="space-y-1.5">
            <div className="h-3 w-3/4 bg-slate-100 rounded animate-pulse" />
            <div className="h-3 w-1/2 bg-slate-100 rounded animate-pulse" />
          </div>
        </div>
      ) : hasEditor ? (
        crdtError ? (
          <div className="border border-status-red rounded-md p-3 bg-status-red-light/30 text-sm text-status-red my-2">
            <p className="font-semibold mb-1">CRDT connection failed</p>
            <p className="text-xs">{crdtError}</p>
          </div>
        ) : (
          <div className="relative">
            {/* ReactMarkdown underlayer — visible until editor is ready */}
            <div className="doc-prose" style={{ display: isReady ? "none" : undefined }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
            </div>
            {/* MilkdownEditor overlay — absolute until ready, then back in flow */}
            <div
              className={isReady ? "" : "absolute inset-0"}
              style={{ minHeight: isReady ? undefined : 60 }}
              onMouseDown={(e) => { mouseDownPosRef.current = { x: e.clientX, y: e.clientY }; }}
              onClick={(e) => {
                const down = mouseDownPosRef.current;
                if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
                if (!isFocused) {
                  onFocusSection(i, section.heading_path, { x: e.clientX, y: e.clientY });
                }
              }}
            >
              <MilkdownEditor
                ref={(handle) => onSetEditorRef(i, handle)}
                markdown={section.content}
                crdtProvider={proposalMode ? null : crdtProvider}
                fragmentKey={fk}
                userName={resolveWriterId()}
                readOnly={!isFocused}
                onChange={proposalMode && onProposalSectionChange ? (md) => onProposalSectionChange(i, md) : undefined}
                onCursorExit={(direction) => onCursorExit(i, direction)}
                onCrossSectionDrop={(transfer) => onCrossSectionDrop(section, transfer)}
                onReady={() => onEditorReady(i)}
              />
            </div>
          </div>
        )
      ) : (
        <div className="doc-prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
