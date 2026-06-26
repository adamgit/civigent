import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router-dom";
import { MilkdownEditor, type MilkdownEditorHandle } from "./MilkdownEditor";
import type { BrowserFragmentReplicaStore } from "../services/browser-fragment-replica-store";
import type { CrdtTransport } from "../services/crdt-transport";
import type { CrdtConnectionState } from "../services/crdt-provider";
import { isCrdtDegraded, crdtBannerInfo } from "../services/crdt-connection-ux";
import type { DocumentSection } from "../pages/document-page-utils";
import { headingPathToLabel } from "../pages/document-page-utils";
import { resolveWriterId } from "../services/api-client";
import type { LocalEditOriginSink } from "../status/sessionAuthorship";
import type { SectionTransfer, SectionTransferService } from "../services/section-transfer";
import { useSectionHover } from "../contexts/sectionHoverUtils";
import { rewriteMarkdownDocHref } from "../app/docsRouteUtils";

export interface DocumentSectionRendererProps {
  section: DocumentSection;
  index: number;
  fragmentKey: string;
  isFocused: boolean;
  hasEditor: boolean;
  isInProposal: boolean;
  proposalConflictReason: string | null;
  /** Proposal FSM lock conflict (another proposal owns this section). NOT
   *  CRDT block-state and NOT agent write-policy. */
  isLockedByOtherHuman: boolean;
  /** CRDT server-driven block-state: section:blocked → read-only. */
  crdtBlocked: boolean;
  /** DocSession publication pause active → editor frozen. */
  publishPaused: boolean;
  highlightLabel: string | null;
  injectedByWriter: string | null;
  hasRemotePresence: boolean;
  dragOverSectionIndex: number | null;
  store: BrowserFragmentReplicaStore | null;
  transport: CrdtTransport | null;
  crdtSynced: boolean;
  /** CRDT transport connection state. `reconnecting`/`error` mean the socket is
   *  down: the section keeps showing its (in-memory) content but goes read-only
   *  + faded rather than being blanked. */
  crdtState: CrdtConnectionState;
  transferService: SectionTransferService | null;
  proposalMode: boolean;
  canEditProposalContent: boolean;
  proposalScopeMutationInFlight: boolean;
  isReady: boolean;
  /** Write-only port: records that THIS session locally authored an edit to this
   *  fragment, so the save-status ladder can tell your work from inbound activity.
   *  Typed as the sink only — this component can write, never read or serialize. */
  localEditSink: LocalEditOriginSink;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  onStartEditing: (index: number, coords: { x: number; y: number }) => void;
  onFocusSection: (index: number, headingPath: string[], coords: { x: number; y: number }) => void;
  onSetEditorRef: (fragmentKey: string, handle: MilkdownEditorHandle | null) => void;
  onEditorReady: (fragmentKey: string) => void;
  onEditorUnready?: (fragmentKey: string) => void;
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
  crdtBlocked,
  publishPaused,
  highlightLabel,
  injectedByWriter,
  hasRemotePresence,
  dragOverSectionIndex,
  store,
  transport,
  crdtSynced,
  crdtState,
  transferService,
  proposalMode,
  canEditProposalContent,
  proposalScopeMutationInFlight,
  isReady,
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
}: DocumentSectionRendererProps) {
  const { setHoveredSection } = useSectionHover();
  // Unavailable-for-human-edit: a proposal FSM lock conflict OR a CRDT
  // block-state. (Publication pause does not remove the section, it only
  // freezes the live editor — handled via the `readOnly` prop below.)
  const unavailableForEdit = isLockedByOtherHuman || crdtBlocked;
  // Transport is not live (first-connect `connecting`, dropped `reconnecting`,
  // or hard `error`/`disconnected`). The Y.Doc still holds all content in memory,
  // so we keep rendering the section — we do NOT blank it. Offline keystrokes
  // would be silently dropped by `sendRaw` (and an unsynced editor isn't typeable
  // anyway), so the live editor is forced read-only + faded while degraded and
  // eagerly-mounted neighbors fall back to faded static content. Every non-live
  // phase is covered — see crdt-connection-ux.ts (the `connecting` flash on a
  // healthy connect is sub-second; a hung/dead server stays here).
  const crdtDegraded = isCrdtDegraded(crdtState);
  const crdtPaused = crdtBannerInfo(crdtState);
  const markdownComponents = {
    a({ node: _node, href, children, ...props }: React.ComponentProps<"a"> & { node?: unknown }) {
      const resolvedHref = typeof href === "string" ? rewriteMarkdownDocHref(href) : null;
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
    },
  };

  return (
    <div
      key={fk}
      data-section-index={i}
      data-fragment-key={fk}
      data-heading-path={JSON.stringify(section.heading_path)}
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
      }${dragOverSectionIndex === i ? " section-drop-target" : ""}${injectedByWriter ? " section-injected-flash" : ""}`}
      onMouseEnter={() => setHoveredSection(i)}
      onMouseLeave={() => setHoveredSection(null)}
      onMouseDown={(e) => { mouseDownPosRef.current = { x: e.clientX, y: e.clientY }; }}
      onClick={unavailableForEdit || publishPaused ? undefined : hasEditor ? undefined : (e) => {
        if (e.shiftKey || e.button !== 0 || e.defaultPrevented) return;
        if (window.getSelection()?.isCollapsed === false) return;
        const down = mouseDownPosRef.current;
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
        if (proposalMode) {
          if (!canEditProposalContent) {
            if (proposalScopeMutationInFlight) return;
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
            disabled={proposalScopeMutationInFlight}
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
        crdtDegraded && !isFocused ? (
          // Degraded neighbor: this editor was eagerly mounted (focused ±1) but
          // is not the one being edited. Edits can't be synced while the socket
          // is not live, so fall back to faded static content rather than a live
          // editor.
          <div className="doc-prose opacity-50">
            <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
              {section.content}
            </ReactMarkdown>
          </div>
        ) : (
          <>
            {/* Degraded focused section: editing is paused until the socket is
                live again. `crdtPaused` is non-null for every non-live phase
                (connecting / reconnecting / offline), each with its own label. */}
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
              {/* ReactMarkdown underlayer — shown until editor is ready, then unmounted */}
              {!isReady && (
                <div className="doc-prose">
                  <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                    {section.content}
                  </ReactMarkdown>
                </div>
              )}
              {/* MilkdownEditor overlay — absolute until ready, then back in flow */}
              <div
                className={isReady ? "" : "absolute inset-0"}
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
                  ref={(handle) => onSetEditorRef(fk, handle)}
                  markdown={section.content}
                  store={proposalMode ? null : store}
                  transport={proposalMode ? null : transport}
                  crdtSynced={crdtSynced}
                  fragmentKey={fk}
                  userName={resolveWriterId()}
                  readOnly={!isFocused || unavailableForEdit || publishPaused || crdtDegraded || (proposalMode && !canEditProposalContent)}
                  expectsCrdt={!proposalMode}
                  onChange={proposalMode && canEditProposalContent && onProposalSectionChange
                    ? (md) => onProposalSectionChange(i, md)
                    : undefined}
                  canDrop={transferService ? () => transferService.canDrop(fk) : undefined}
                  onCursorExit={(direction) => onCursorExit(i, direction)}
                  onCrossSectionDrop={(transfer) => onCrossSectionDrop(section, transfer)}
                  onLocalEdit={() => localEditSink.recordLocalEdit(fk)}
                  onReady={() => onEditorReady(fk)}
                  onUnready={onEditorUnready ? () => onEditorUnready(fk) : undefined}
                />
              </div>
            </div>
          </>
        )
      ) : (
        <div className="doc-prose">
          <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
            {section.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
