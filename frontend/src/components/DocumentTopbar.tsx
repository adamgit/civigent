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
}: DocumentTopbarProps) {
  // The legacy per-section save-status popup (SAVE_STATE_META + receipt
  // lifecycle) is removed (spec 05 §"Section-Level Persistence Status
  // Indicators"). The topbar now shows a single coarse transport/publish
  // status derived from the live connection state and the publication-pause
  // flag — nothing per-section.
  const status = resolveTransportStatus(crdtState, publishPaused, isEditing);
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
