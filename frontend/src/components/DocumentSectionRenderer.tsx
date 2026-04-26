import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MilkdownEditor, type MilkdownEditorHandle } from "./MilkdownEditor";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { CrdtTransport } from "../services/crdt-transport";
import type { DocumentSection } from "../pages/document-page-utils";
import { headingPathToLabel } from "../pages/document-page-utils";
import { resolveWriterId } from "../services/api-client";
import type { SectionTransfer, SectionTransferService } from "../services/section-transfer";
import { useSectionHover } from "../contexts/sectionHoverUtils";

export interface DocumentSectionRendererProps {
  section: DocumentSection;
  index: number;
  fragmentKey: string;
  isFocused: boolean;
  hasEditor: boolean;
  isInProposal: boolean;
  proposalConflictReason: string | null;
  isLockedByOtherHuman: boolean;
  highlightLabel: string | null;
  injectedByWriter: string | null;
  hasRemotePresence: boolean;
  dragOverSectionIndex: number | null;
  store: BrowserFragmentReplicaStore | null;
  transport: CrdtTransport | null;
  crdtSynced: boolean;
  crdtError: string | null;
  transferService: SectionTransferService | null;
  proposalMode: boolean;
  canEditProposalContent: boolean;
  isReady: boolean;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  onStartEditing: (index: number, coords: { x: number; y: number }) => void;
  onFocusSection: (index: number, headingPath: string[], coords: { x: number; y: number }) => void;
  onSetEditorRef: (index: number, handle: MilkdownEditorHandle | null) => void;
  onEditorReady: (index: number) => void;
  onEditorUnready?: (index: number) => void;
  onProposalSectionChange?: (index: number, markdown: string) => void;
  onToggleProposalSection?: () => void;
  onCursorExit: (index: number, direction: "up" | "down") => void;
  onCrossSectionDrop: (section: DocumentSection, transfer: SectionTransfer) => void;
}

function playFlyToProposalPanelAnimation(fromX: number, fromY: number): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const marker = document.createElement("div");
  marker.textContent = "+";
  marker.setAttribute("aria-hidden", "true");
  marker.style.position = "fixed";
  marker.style.left = `${fromX}px`;
  marker.style.top = `${fromY}px`;
  marker.style.transform = "translate(-50%, -50%) scale(1)";
  marker.style.opacity = "1";
  marker.style.pointerEvents = "none";
  marker.style.zIndex = "3000";
  marker.style.width = "18px";
  marker.style.height = "18px";
  marker.style.borderRadius = "9999px";
  marker.style.border = "1px solid #60a5fa";
  marker.style.background = "#dbeafe";
  marker.style.color = "#1d4ed8";
  marker.style.display = "flex";
  marker.style.alignItems = "center";
  marker.style.justifyContent = "center";
  marker.style.fontSize = "12px";
  marker.style.fontWeight = "700";
  marker.style.transition = "left 360ms cubic-bezier(0.2, 0.85, 0.2, 1), top 360ms cubic-bezier(0.2, 0.85, 0.2, 1), transform 360ms cubic-bezier(0.2, 0.85, 0.2, 1), opacity 360ms ease";
  document.body.appendChild(marker);

  const topbarRaw = getComputedStyle(document.documentElement).getPropertyValue("--spacing-topbar-h").trim();
  const topbarHeight = Number.parseFloat(topbarRaw);
  const toX = window.innerWidth - 70;
  const toY = (Number.isFinite(topbarHeight) ? topbarHeight : 56) + 38;

  requestAnimationFrame(() => {
    marker.style.left = `${toX}px`;
    marker.style.top = `${toY}px`;
    marker.style.transform = "translate(-50%, -50%) scale(0.7)";
    marker.style.opacity = "0";
  });
  window.setTimeout(() => marker.remove(), 420);
}

export function DocumentSectionRenderer({
  section,
  index: i,
  fragmentKey: fk,
  isFocused,
  hasEditor,
  isInProposal,
  proposalConflictReason,
  isLockedByOtherHuman,
  highlightLabel,
  injectedByWriter,
  hasRemotePresence,
  dragOverSectionIndex,
  store,
  transport,
  crdtSynced,
  crdtError,
  transferService,
  proposalMode,
  canEditProposalContent,
  isReady,
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
        if (e.shiftKey || e.button !== 0 || e.defaultPrevented) return;
        if (window.getSelection()?.isCollapsed === false) return;
        const down = mouseDownPosRef.current;
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
        if (proposalMode) {
          if (!canEditProposalContent) {
            if (!isInProposal && onToggleProposalSection) {
              playFlyToProposalPanelAnimation(e.clientX, e.clientY);
              void onToggleProposalSection();
            }
            return;
          }
          if (!isInProposal) {
            return;
          }
          onFocusSection(i, section.heading_path, { x: e.clientX, y: e.clientY });
          return;
        }
        void onStartEditing(i, { x: e.clientX, y: e.clientY });
      }}
    >
      {/* Injection attribution — fading right-gutter message when a proposal injected this section */}
      {injectedByWriter ? (
        <span className="section-injected-msg">
          Updated by {injectedByWriter}
        </span>
      ) : null}

      {proposalMode && onToggleProposalSection ? (
        <div className="absolute right-2 top-2 z-10">
          <button
            type="button"
            className={`text-[10px] px-2 py-0.5 rounded border ${
              isInProposal
                ? "bg-blue-50 text-blue-700 border-blue-300"
                : "bg-white text-slate-700 border-slate-300"
            }`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void onToggleProposalSection();
            }}
          >
            {isInProposal ? "Remove" : "Add"}
          </button>
        </div>
      ) : null}

      {proposalMode && isInProposal && proposalConflictReason ? (
        <div className="mb-1">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded">
            error/unacquirable: {proposalConflictReason}
          </span>
        </div>
      ) : null}

      {/* Remote presence indicator */}
      {hasRemotePresence ? (
        <span className="text-[10px] text-blue-600">
          Someone else is editing
        </span>
      ) : null}

      {/* Section body: editor or static preview */}
      {hasEditor ? (
        crdtError ? (
          <div className="border border-status-red rounded-md p-3 bg-status-red-light/30 text-sm text-status-red my-2">
            <p className="font-semibold mb-1">CRDT connection failed</p>
            <p className="text-xs">{crdtError}</p>
          </div>
        ) : (
          <div className="relative">
            {/* ReactMarkdown underlayer — shown until editor is ready, then unmounted */}
            {!isReady && (
              <div className="doc-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
              </div>
            )}
            {/* MilkdownEditor overlay — absolute until ready, then back in flow */}
            <div
              className={isReady ? "" : "absolute inset-0"}
              style={{ minHeight: isReady ? undefined : 60 }}
              onMouseDown={(e) => { mouseDownPosRef.current = { x: e.clientX, y: e.clientY }; }}
              onClick={(e) => {
                if (e.shiftKey || e.button !== 0 || e.defaultPrevented) return;
                if (window.getSelection()?.isCollapsed === false) return;
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
                store={proposalMode ? null : store}
                transport={proposalMode ? null : transport}
                crdtSynced={crdtSynced}
                fragmentKey={fk}
                userName={resolveWriterId()}
                readOnly={!isFocused || isLockedByOtherHuman || (proposalMode && !canEditProposalContent)}
                expectsCrdt={!proposalMode}
                onChange={proposalMode && canEditProposalContent && onProposalSectionChange
                  ? (md) => onProposalSectionChange(i, md)
                  : undefined}
                canDrop={transferService ? () => transferService.canDrop(fk) : undefined}
                onCursorExit={(direction) => onCursorExit(i, direction)}
                onCrossSectionDrop={(transfer) => onCrossSectionDrop(section, transfer)}
                onReady={() => onEditorReady(i)}
                onUnready={onEditorUnready ? () => onEditorUnready(i) : undefined}
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
