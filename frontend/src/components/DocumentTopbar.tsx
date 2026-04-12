import { useState } from "react";
import { Link } from "react-router-dom";
import type { CrdtConnectionState } from "../services/crdt-provider";
import { type SectionSaveInfo, type SectionSaveState, SAVE_STATE_META } from "../services/section-save-state";

interface DocumentTopbarProps {
  docPath: string | null;
  showHistory: boolean;
  onToggleHistory: () => void;
  showDiagnostics: boolean;
  onToggleDiagnostics: () => void;
  showOverwrite?: boolean;
  onToggleOverwrite?: () => void;
  crdtState: CrdtConnectionState;
  aggregateSaveState: SectionSaveState;
  sectionSaveInfos: SectionSaveInfo[];
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
  aggregateSaveState,
  sectionSaveInfos,
  isEditing,
}: DocumentTopbarProps) {
  const [popupOpen, setPopupOpen] = useState(false);

  const meta = SAVE_STATE_META[aggregateSaveState];
  const hasSections = sectionSaveInfos.length > 0;

  const indicatorLabel =
    crdtState === "error" ? "Sync error"
    : crdtState === "reconnecting" ? "Reconnecting\u2026"
    : crdtState === "connecting" ? "Syncing\u2026"
    : hasSections ? meta.label
    : isEditing ? "Up to date"
    : "";

  const dotClass =
    crdtState === "error" ? "bg-red-500"
    : crdtState === "reconnecting" ? "bg-red-500 animate-[pulse-dot_1.5s_ease-in-out_infinite]"
    : crdtState === "connecting" ? "bg-amber-400 animate-[pulse-dot_1.5s_ease-in-out_infinite]"
    : hasSections ? meta.dotClass
    : "bg-green-500";

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

      {/* Aggregated persistence indicator with per-section popup */}
      <div className="relative">
        <button
          type="button"
          className="flex items-center gap-[5px] cursor-pointer hover:opacity-80"
          onClick={() => hasSections && setPopupOpen((v) => !v)}
          title={hasSections ? "Click to see per-section save status" : undefined}
        >
          <div className={`w-[7px] h-[7px] rounded-full ${dotClass}`} />
          <span className="text-[11px] text-text-muted">
            {indicatorLabel}
          </span>
        </button>

        {/* Per-section popup (Bug 4) */}
        {popupOpen && hasSections && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setPopupOpen(false)}
            />
            <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-[#e0ddd8] rounded-md shadow-lg min-w-[260px] max-w-[360px] py-1.5">
              <div className="px-3 py-1 text-[10px] font-semibold text-text-muted uppercase tracking-wider border-b border-[#f0ede8] mb-1">
                Section Save Status
              </div>
              {sectionSaveInfos.map((info) => {
                const sm = SAVE_STATE_META[info.state];
                return (
                  <div
                    key={info.fragmentKey}
                    className="flex items-center gap-2 px-3 py-1 hover:bg-[#faf8f5]"
                  >
                    <div className={`w-[6px] h-[6px] rounded-full shrink-0 ${sm.dotClass}`} />
                    <span className="text-[11px] text-text-primary truncate flex-1">
                      {info.sectionLabel}
                    </span>
                    <span className={`text-[10px] font-medium shrink-0 ${sm.color}`}>
                      {sm.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </header>
  );
}
