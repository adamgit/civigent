/**
 * The strip above the map: which presentation to draw, and the four hit-kind
 * filters. The kinds answer different questions; the counts are for the whole
 * search so a zero means that kind was searched and found nothing. Clicking a
 * kind shows only those hits (map and cards). Clicking again clears it; several
 * can be on at once.
 */
import type { SearchHitKind } from "../../services/api-client";
import type { HitKindCounts } from "./search-hit-forest";
import { SEARCH_HIT_KIND_ORDER, SEARCH_HIT_KIND_TOKENS } from "./search-hit-kinds";

export type SearchMapMode = "folder" | "treemap";

const MODE_LABELS: Record<SearchMapMode, string> = {
  folder: "Folder map",
  treemap: "Treemap",
};

export function SearchMapChrome({
  mode,
  onModeChange,
  counts,
  kindFilter,
  onToggleKind,
}: {
  mode: SearchMapMode;
  onModeChange: (mode: SearchMapMode) => void;
  /** Whole-search counts, so the legend describes the entire result set. */
  counts: HitKindCounts;
  kindFilter: readonly SearchHitKind[];
  onToggleKind: (kind: SearchHitKind) => void;
}) {
  return (
    <div className="shrink-0 flex items-center gap-x-3 gap-y-1.5 flex-wrap">
      <div
        className="flex items-center gap-1 rounded-lg border p-0.5"
        style={{ borderColor: "var(--color-footer-border)", background: "var(--color-page-bg)" }}
        role="group"
        aria-label="Map presentation"
      >
        {(["folder", "treemap"] as const).map((candidate) => {
          const active = candidate === mode;
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={active}
              onClick={() => onModeChange(candidate)}
              className="text-[12px] font-medium px-2.5 py-1 rounded-md border transition-colors"
              style={{
                color: active ? "var(--color-accent-text)" : "var(--color-text-muted)",
                background: active ? "var(--color-accent-light)" : "transparent",
                borderColor: active ? "var(--color-accent-border)" : "transparent",
              }}
            >
              {MODE_LABELS[candidate]}
            </button>
          );
        })}
      </div>

      {/* Short labels: the legend sits in a narrow column beside the results,
          and the full description rides along as the tooltip. */}
      <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Filter by hit kind">
        {SEARCH_HIT_KIND_ORDER.map((kind) => {
          const tokens = SEARCH_HIT_KIND_TOKENS[kind];
          const filtering = kindFilter.length > 0;
          const pressed = kindFilter.includes(kind);
          const muted = filtering && !pressed;
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={pressed}
              onClick={() => onToggleKind(kind)}
              className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap cursor-pointer"
              style={{
                color: tokens.foreground,
                background: muted ? "transparent" : tokens.background,
                borderColor: tokens.border,
                opacity: muted ? 0.45 : 1,
              }}
              title={`${tokens.label} — ${tokens.description}. Click to ${pressed ? "stop filtering to this kind" : "show only this kind"}.`}
            >
              <tokens.Icon size={12} />
              {tokens.shortLabel}
              <span className="font-mono opacity-80">{counts[kind]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
