import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { MilkdownEditor, type MilkdownEditorHandle } from "./MilkdownEditor";
import type { CrdtConnectionState } from "../services/crdt-provider";
import { isCrdtDegraded, crdtBannerInfo } from "../services/crdt-connection-ux";
import { headingPathToLabel } from "../pages/document-page-utils";
import type { RenderSectionRef } from "../types/live-sections";
import { resolveWriterId } from "../services/api-client";
import type { LocalEditOriginSink } from "../status/sessionAuthorship";
import type { SectionTransfer, SectionTransferService } from "../services/section-transfer";
import { useSetHoveredFragmentKey } from "../contexts/sectionHoverUtils";
import { rewriteMarkdownContentHref } from "../app/docs-location";

const REMARK_PLUGINS = [remarkGfm];

function MarkdownContentLink({
  node: _node,
  href,
  children,
  ...props
}: React.ComponentProps<"a"> & { node?: unknown }) {
  const resolvedHref = typeof href === "string" ? rewriteMarkdownContentHref(href) : null;
  if (resolvedHref) {
    return (
      <Link {...props} to={resolvedHref}>
        {children}
      </Link>
    );
  }
  return (
    <a {...props} href={href}>
      {children}
    </a>
  );
}

const markdownComponents = { a: MarkdownContentLink };

const StaticSectionMarkdown = React.memo(function StaticSectionMarkdown({
  markdown,
  className = "doc-prose",
}: {
  markdown: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={REMARK_PLUGINS}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
});

export interface DocumentSectionRendererProps {
  section: RenderSectionRef;
  fragmentKey: string;
  isFocused: boolean;
  hasEditor: boolean;
  isInProposal: boolean;
  proposalConflictReason: string | null;
  isLockedByOtherHuman: boolean;
  crdtBlocked: boolean;
  publishPaused: boolean;
  highlightLabel: string | null;
  injectedByWriter: string | null;
  hasRemotePresence: boolean;
  dragOverFragmentKey: string | null;
  crdtState: CrdtConnectionState;
  transferService: SectionTransferService | null;
  proposalMode: boolean;
  canEditProposalContent: boolean;
  proposalScopeMutationInFlight: boolean;
  isReady: boolean;
  /** Changes exactly when this row's live fragment changes. Its only job is to
   *  let the shallow memo below skip rows whose content did not move. */
  replicaFragmentVersion: number;
  getDisplayMarkdown: (section: RenderSectionRef) => string;
  getLiveBinding?: (fragmentKey: string) => import("../services/live-section-replica").LiveEditorBinding | undefined;
  localEditSink: LocalEditOriginSink;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  onStartEditing: (fragmentKey: string, coords: { x: number; y: number }) => void;
  onFocusSection: (fragmentKey: string, headingPath: string[], coords: { x: number; y: number }) => void;
  onSetEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  onEditorReady: (fragmentKey: string) => void;
  onEditorUnready?: (fragmentKey: string) => void;
  onProposalSectionChange?: (headingPath: readonly string[], markdown: string) => void;
  onToggleProposalSection?: (target: RenderSectionRef) => void | Promise<void>;
  onCursorExit: (fragmentKey: string, direction: "up" | "down") => void;
  onDocumentBoundary: (boundary: "start" | "end") => void;
  onCrossSectionDrop: (target: RenderSectionRef, transfer: SectionTransfer) => void;
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

export const DocumentSectionRenderer = React.memo(function DocumentSectionRenderer({
  section,
  fragmentKey: fk,
  isFocused,
  hasEditor,
  isInProposal,
  proposalConflictReason,
  isLockedByOtherHuman,
  crdtBlocked,
  publishPaused,
  highlightLabel,
  injectedByWriter,
  hasRemotePresence,
  dragOverFragmentKey,
  crdtState,
  transferService,
  proposalMode,
  canEditProposalContent,
  proposalScopeMutationInFlight,
  isReady,
  replicaFragmentVersion: _replicaFragmentVersion,
  getDisplayMarkdown,
  getLiveBinding,
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
}: DocumentSectionRendererProps) {
  const setHoveredFragmentKey = useSetHoveredFragmentKey();
  const headingPath = [...section.headingPath];
  const unavailableForEdit = isLockedByOtherHuman || crdtBlocked;
  const liveBinding = !proposalMode && hasEditor ? getLiveBinding?.(fk) : undefined;
  const mountEditor = hasEditor && (proposalMode || liveBinding !== undefined);
  const crdtDegraded = isCrdtDegraded(crdtState);
  const crdtPaused = crdtBannerInfo(crdtState);
  const displayMarkdown = getDisplayMarkdown(section);

  return (
    <div
      key={fk}
      data-document-section=""
      data-fragment-key={fk}
      data-heading-path={JSON.stringify(headingPath)}
      className={`relative mx-[-16px] px-[16px] rounded-md border-l-[2.5px] transition-all group ${
        unavailableForEdit
          ? `bg-amber-50/50 border-l-amber-400 opacity-75`
          : isInProposal
          ? `bg-blue-50/30 border-l-blue-500`
          : highlightLabel
          ? `bg-green-50/70 border-l-green-400 cursor-pointer hover:bg-section-hover`
          : isFocused && crdtDegraded
          ? `cursor-pointer border-l-amber-400 opacity-75`
          : isFocused
          ? `cursor-pointer hover:bg-section-hover border-l-accent-emphasis`
          : hasRemotePresence
          ? `cursor-pointer hover:bg-section-hover border-l-blue-400`
          : `cursor-pointer hover:bg-section-hover border-l-transparent`
      }${dragOverFragmentKey === fk ? " section-drop-target" : ""}${injectedByWriter ? " section-injected-flash" : ""}`}
      onMouseEnter={() => setHoveredFragmentKey(fk)}
      onMouseLeave={() => setHoveredFragmentKey(null)}
      onMouseDown={(e) => { mouseDownPosRef.current = { x: e.clientX, y: e.clientY }; }}
      onClick={unavailableForEdit || publishPaused ? undefined : hasEditor ? undefined : (e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.button !== 0 || e.defaultPrevented) return;
        if (window.getSelection()?.isCollapsed === false) return;
        const down = mouseDownPosRef.current;
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
        if (proposalMode) {
          if (!canEditProposalContent) {
            if (proposalScopeMutationInFlight) return;
            if (!isInProposal && onToggleProposalSection) {
              playFlyToProposalPanelAnimation(e.clientX, e.clientY);
              void onToggleProposalSection(section);
            }
            return;
          }
          if (!isInProposal) {
            return;
          }
          onFocusSection(fk, headingPath, { x: e.clientX, y: e.clientY });
          return;
        }
        void onStartEditing(fk, { x: e.clientX, y: e.clientY });
      }}
    >
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
            disabled={proposalScopeMutationInFlight}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void onToggleProposalSection(section);
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

      {hasRemotePresence ? (
        <span className="text-[10px] text-blue-600">
          Someone else is editing
        </span>
      ) : null}

      {mountEditor ? (
        crdtDegraded && !isFocused ? (
          <StaticSectionMarkdown markdown={displayMarkdown} className="doc-prose opacity-50" />
        ) : (
          <>
            {crdtPaused ? (
              <p
                className={`text-[10px] font-medium mb-1 ${
                  crdtPaused.tone === "red" ? "text-status-red" : "text-amber-700"
                }`}
              >
                {crdtPaused.sectionLabel}
              </p>
            ) : null}
            <div className={`relative${crdtDegraded ? " opacity-50" : ""}`}>
              {!isReady && (
                <StaticSectionMarkdown markdown={displayMarkdown} />
              )}
              <div
                className={isReady ? "" : "absolute inset-0"}
                onMouseDown={(e) => { mouseDownPosRef.current = { x: e.clientX, y: e.clientY }; }}
                onClick={(e) => {
                  if (e.shiftKey || e.ctrlKey || e.metaKey || e.button !== 0 || e.defaultPrevented) return;
                  if (window.getSelection()?.isCollapsed === false) return;
                  const down = mouseDownPosRef.current;
                  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
                  if (!isFocused) {
                    onFocusSection(fk, headingPath, { x: e.clientX, y: e.clientY });
                  }
                }}
              >
                {proposalMode ? (
                  <MilkdownEditor
                    ref={(handle) => { onSetEditorRef(fk, handle); }}
                    markdown={displayMarkdown}
                    userName={resolveWriterId()}
                    readOnly={!isFocused || unavailableForEdit || publishPaused || crdtDegraded || !canEditProposalContent}
                    onChange={canEditProposalContent && onProposalSectionChange
                      ? (md) => onProposalSectionChange(section.headingPath, md)
                      : undefined}
                    canDrop={transferService ? () => transferService.canDrop(fk) : undefined}
                    onCursorExit={(direction) => onCursorExit(fk, direction)}
                    onDocumentBoundary={onDocumentBoundary}
                    onCrossSectionDrop={(transfer) => onCrossSectionDrop(section, transfer)}
                    onLocalEdit={() => localEditSink.recordLocalEdit(fk)}
                    onReady={() => onEditorReady(fk)}
                    onUnready={onEditorUnready ? () => onEditorUnready(fk) : undefined}
                  />
                ) : liveBinding ? (
                  <MilkdownEditor
                    ref={(handle) => { onSetEditorRef(fk, handle); }}
                    binding={liveBinding}
                    userName={resolveWriterId()}
                    readOnly={!isFocused || unavailableForEdit || publishPaused || crdtDegraded}
                    expectsCrdt
                    canDrop={transferService ? () => transferService.canDrop(fk) : undefined}
                    onCursorExit={(direction) => onCursorExit(fk, direction)}
                    onDocumentBoundary={onDocumentBoundary}
                    onCrossSectionDrop={(transfer) => onCrossSectionDrop(section, transfer)}
                    onLocalEdit={() => localEditSink.recordLocalEdit(fk)}
                    onReady={() => onEditorReady(fk)}
                    onUnready={onEditorUnready ? () => onEditorUnready(fk) : undefined}
                  />
                ) : null}
              </div>
            </div>
          </>
        )
      ) : (
        <StaticSectionMarkdown markdown={displayMarkdown} />
      )}
    </div>
  );
});
