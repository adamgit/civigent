import { Link } from "react-router-dom";
import type { CrdtConnectionState } from "../services/crdt-provider";
import { resolveTransportStatus, TRANSPORT_STATUS_META } from "../services/section-save-state";

interface DocumentTopbarProps {
  docPath: string | null;
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
}

export function DocumentTopbar({
  docPath,
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
}: DocumentTopbarProps) {
  // The topbar shows a single coarse transport/save status derived from the live
  // connection state, the receipt watermark, the writer-filtered local-edit
  // flags, and the publication-pause flag — honest semantic boundaries, nothing
  // per-section, and a stranger's edits never borrow a first-person label.
  const status = resolveTransportStatus(
    crdtState,
    publishPaused,
    isEditing,
    allReceived,
    hasLocalUncommittedEdits,
    hasInboundActivity,
    hadLocalEdits,
  );
  const meta = TRANSPORT_STATUS_META[status];

  return (
    <header className="h-[--spacing-topbar-h] min-h-[--spacing-topbar-h] bg-topbar-bg border-b border-topbar-border flex items-center px-4 gap-2.5">
      <Link
        to="/docs"
        className="w-[26px] h-[26px] rounded-[5px] flex items-center justify-center text-text-muted text-[15px] hover:bg-section-hover hover:text-text-primary transition-all"
      >
        &#8592;
      </Link>
      <span className="font-[family-name:var(--font-ui)] text-sm font-medium text-text-primary flex-1 truncate">
        {docPath ?? "No document selected"}
      </span>

      {/* Version history toggle */}
      <button
        onClick={onToggleHistory}
        className={`text-[11px] px-2 py-1 rounded ${showHistory ? "bg-[#e8f4f6] text-[#1d5a66]" : "bg-[#f5f2ed] text-text-muted hover:text-text-primary"}`}
        title="Version history"
      >
        History
      </button>

      {/* Diagnostics toggle */}
      <button
        onClick={onToggleDiagnostics}
        className={`text-[11px] px-2 py-1 rounded ${showDiagnostics ? "bg-[#e8f4f6] text-[#1d5a66]" : "bg-[#f5f2ed] text-text-muted hover:text-text-primary"}`}
        title="Document diagnostics"
      >
        Diagnostics
      </button>

      {/* Overwrite from Markdown toggle */}
      {onToggleOverwrite && (
        <button
          onClick={onToggleOverwrite}
          className={`text-[11px] px-2 py-1 rounded ${showOverwrite ? "bg-[#e8f4f6] text-[#1d5a66]" : "bg-[#f5f2ed] text-text-muted hover:text-text-primary"}`}
          title="Overwrite document from raw markdown"
        >
          Overwrite
        </button>
      )}

      {/* Coarse transport/publish status indicator (no per-section popup) */}
      {meta.label ? (
        <div className="flex items-center gap-[5px]">
          <div className={`w-[7px] h-[7px] rounded-full ${meta.dotClass}`} />
          <span className="text-[11px] text-text-muted">{meta.label}</span>
        </div>
      ) : null}
    </header>
  );
}
