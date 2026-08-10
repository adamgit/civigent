import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { folderHref } from "../app/docs-location";
import type { CrdtConnectionState } from "../services/crdt-provider";
import { resolveTransportStatus, TRANSPORT_STATUS_META } from "../services/section-save-state";
import { PublishRequirementsHover } from "./PublishRequirementsHover";
import { FolderPath, type PublishTriggerDecision } from "../types/shared";

interface DocumentTopbarProps {
  /** Canonical document path — used to resolve the parent-folder back link. */
  docPath: string | null;
  /**
   * Optional control rendered just before History (e.g. Standard/Governance/Agent
   * view toggle). Keeps page-specific chrome out of the paper header.
   */
  toolbarAccessory?: ReactNode;
  showHistory: boolean;
  onToggleHistory: () => void;
  showDiagnostics: boolean;
  onToggleDiagnostics: () => void;
  showOverwrite?: boolean;
  onToggleOverwrite?: () => void;
  crdtState: CrdtConnectionState;
  /** True while a DocSession publication pause is freezing editors. */
  publishPaused: boolean;
  isEditing: boolean;
  /** Guarantee A: every local edit acknowledged received by the server. */
  allReceived: boolean;
  /** Guarantee B (local): a live inprogress proposal still holds edits authored
   *  by the current user (writer-filtered, not the global pending set). */
  hasLocalUncommittedEdits: boolean;
  /** Inbound/remote activity not attributable to the current user: another
   *  writer's pending edits exist (or an update just landed) and none are yours. */
  hasInboundActivity: boolean;
  /** Sticky: the user has committed at least one local edit this editing
   *  session — keeps a clean doc on "saved" instead of collapsing to "idle". */
  hadLocalEdits: boolean;
  /** Server-reported durable failure (materialize / normalize / validate /
   *  publish). Surfaced as an explicit `error` rung that must not collapse into
   *  the pending / saved / up-to-date labels. `null` when clean. */
  backendError: string | null;
  /** Live honest publish-status projection for the document, driving the pill hover. */
  publishDecision?: PublishTriggerDecision | null;
}

/** Route for the parent folder's details page, or `/docs` for root-level docs. */
export function parentFolderRoute(docPath: string | null): string {
  if (!docPath) return "/docs";
  const normalized = docPath.replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "/docs";
  const parentFolderPath = FolderPath.tryParse(normalized.slice(0, lastSlash));
  return parentFolderPath ? folderHref(parentFolderPath) : "/docs";
}

function ClockIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-text-muted"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

export function DocumentTopbar({
  docPath,
  toolbarAccessory,
  showHistory,
  onToggleHistory,
  showDiagnostics,
  onToggleDiagnostics,
  showOverwrite,
  onToggleOverwrite,
  crdtState,
  publishPaused,
  isEditing,
  allReceived,
  hasLocalUncommittedEdits,
  hasInboundActivity,
  hadLocalEdits,
  backendError,
  publishDecision = null,
}: DocumentTopbarProps) {
  // The topbar shows a single coarse transport/save status derived from the live
  // connection state, the receipt watermark, the writer-filtered local-edit
  // flags, the publication-pause flag, and the server-reported error signal —
  // honest semantic boundaries, nothing per-section, and a stranger's edits
  // never borrow a first-person label.
  const status = resolveTransportStatus(
    crdtState,
    publishPaused,
    isEditing,
    allReceived,
    hasLocalUncommittedEdits,
    hasInboundActivity,
    hadLocalEdits,
    backendError,
  );
  const meta = TRANSPORT_STATUS_META[status];
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusHoverOpen, setStatusHoverOpen] = useState(false);
  const otherStates = useMemo(
    () =>
      (Object.keys(TRANSPORT_STATUS_META) as (keyof typeof TRANSPORT_STATUS_META)[])
        .filter((key) => key !== status && TRANSPORT_STATUS_META[key].label.length > 0)
        .map((key) => ({ key, ...TRANSPORT_STATUS_META[key] })),
    [status],
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const menuActive = showDiagnostics || !!showOverwrite;
  const backTo = useMemo(() => parentFolderRoute(docPath), [docPath]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  return (
    <header className="h-[--spacing-topbar-h] min-h-[--spacing-topbar-h] bg-transparent flex items-center px-4 gap-2.5">
      <Link
        to={backTo}
        className="w-[26px] h-[26px] rounded-[5px] flex items-center justify-center text-text-muted text-[15px] hover:bg-section-hover hover:text-text-primary transition-all"
        title="Back to folder"
        aria-label="Back to folder"
      >
        &#8592;
      </Link>

      <div className="flex-1" />

      {toolbarAccessory}

      {/* Version history toggle */}
      <button
        onClick={onToggleHistory}
        className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded ${showHistory ? "bg-[#e8f4f6] text-[#1d5a66]" : "bg-[#f5f2ed] text-text-muted hover:text-text-primary"}`}
        title="Version history"
      >
        <ClockIcon />
        History
      </button>

      {/* Overflow menu: diagnostics + overwrite */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((open) => !open)}
          className={`w-[26px] h-[26px] rounded flex items-center justify-center text-[15px] leading-none ${
            menuOpen || menuActive
              ? "bg-[#e8f4f6] text-[#1d5a66]"
              : "bg-[#f5f2ed] text-text-muted hover:text-text-primary"
          }`}
          title="More options"
          aria-label="More options"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          &#8943;
        </button>
        {menuOpen ? (
          <div
            role="menu"
            className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded border border-topbar-border bg-canvas-bg py-1 shadow-sm"
          >
            <button
              role="menuitem"
              onClick={() => {
                onToggleDiagnostics();
                setMenuOpen(false);
              }}
              className={`w-full text-left text-[11px] px-3 py-1.5 ${
                showDiagnostics
                  ? "bg-[#e8f4f6] text-[#1d5a66]"
                  : "text-text-muted hover:bg-section-hover hover:text-text-primary"
              }`}
            >
              Diagnostics
            </button>
            {onToggleOverwrite ? (
              <button
                role="menuitem"
                onClick={() => {
                  onToggleOverwrite();
                  setMenuOpen(false);
                }}
                className={`w-full text-left text-[11px] px-3 py-1.5 ${
                  showOverwrite
                    ? "bg-[#e8f4f6] text-[#1d5a66]"
                    : "text-text-muted hover:bg-section-hover hover:text-text-primary"
                }`}
              >
                Overwrite
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Coarse transport/publish status indicator; hover explains the detail. */}
      {meta.label ? (
        <div
          className="relative flex items-center gap-[5px] cursor-help"
          data-testid="transport-status-pill"
          tabIndex={0}
          aria-label={`Document status: ${meta.label}`}
          onMouseEnter={() => setStatusHoverOpen(true)}
          onMouseLeave={() => setStatusHoverOpen(false)}
          onFocus={() => setStatusHoverOpen(true)}
          onBlur={() => setStatusHoverOpen(false)}
        >
          <div className={`w-[7px] h-[7px] rounded-full ${meta.dotClass}`} />
          <span className="text-[11px] text-text-muted">{meta.label}</span>
          {statusHoverOpen ? (
            <PublishRequirementsHover
              decision={publishDecision}
              what={`This is the whole document's status right now: “${meta.label}”.`}
              why="Saved means your work reached the server; Draft means it's saved but not yet published to the shared document. The status below shows what's left before it publishes."
              extra={
                otherStates.length > 0 ? (
                  <div className="publish-requirements-section">
                    <div className="publish-requirements-heading">Other states you might see</div>
                    <ul className="publish-requirements-other-states">
                      {otherStates.map((s) => (
                        <li key={s.key} className="flex items-center gap-1.5">
                          <span className={`inline-block w-[7px] h-[7px] rounded-full ${s.dotClass}`} />
                          <span>{s.label}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null
              }
            />
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
