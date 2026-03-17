import { Link } from "react-router-dom";
import type { CrdtConnectionState } from "../services/crdt-provider";

export interface PersistenceSummary {
  dirtyCount: number;
  pendingCount: number;
  flushedCount: number;
  deletingCount: number;
  total: number;
}

interface DocumentTopbarProps {
  docPath: string | null;
  showHistory: boolean;
  onToggleHistory: () => void;
  crdtState: CrdtConnectionState;
  persistenceSummary: PersistenceSummary;
  isEditing: boolean;
}

export function DocumentTopbar({
  docPath,
  showHistory,
  onToggleHistory,
  crdtState,
  persistenceSummary,
  isEditing,
}: DocumentTopbarProps) {
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

      {/* Aggregated persistence indicator — derived from per-section state map */}
      <div className="flex items-center gap-[5px]">
        <div className={`w-[7px] h-[7px] rounded-full ${
          crdtState === "error" ? "bg-status-red"
          : crdtState === "reconnecting" ? "bg-status-red animate-[pulse-dot_1.5s_ease-in-out_infinite]"
          : crdtState === "connecting" ? "bg-status-yellow animate-[pulse-dot_1.5s_ease-in-out_infinite]"
          : persistenceSummary.pendingCount > 0 ? "bg-amber-400"
          : persistenceSummary.dirtyCount > 0 ? "bg-blue-400"
          : persistenceSummary.flushedCount > 0 ? "bg-status-green opacity-70"
          : persistenceSummary.total === 0 && isEditing ? "bg-status-green"
          : "bg-status-green"
        }`} />
        <span className="text-[11px] text-text-muted">
          {crdtState === "error" ? "Sync error"
          : crdtState === "reconnecting" ? "Reconnecting\u2026"
          : crdtState === "connecting" ? "Syncing\u2026"
          : persistenceSummary.pendingCount > 0 ? `${persistenceSummary.pendingCount} section${persistenceSummary.pendingCount > 1 ? "s" : ""} waiting for save confirmation`
          : persistenceSummary.dirtyCount > 0 ? `${persistenceSummary.dirtyCount} unsaved section${persistenceSummary.dirtyCount > 1 ? "s" : ""}`
          : persistenceSummary.flushedCount > 0 ? "All changes saved"
          : isEditing ? "Up to date"
          : ""}
        </span>
      </div>
    </header>
  );
}
