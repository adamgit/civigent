/**
 * The strip above the map: which presentation to draw, and what the colors mean.
 *
 * The legend is not decoration — the four kinds answer different questions, and
 * without it the map's colors are just colors. It shows all four kinds always,
 * with the counts for this search, so a zero tells you the kind was searched and
 * found nothing rather than leaving you to guess.
 */
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
}: {
  mode: SearchMapMode;
  onModeChange: (mode: SearchMapMode) => void;
  /** Whole-forest counts, so the legend describes the entire result set. */
  counts: HitKindCounts;
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
      <div className="flex items-center gap-1.5 flex-wrap">
        {SEARCH_HIT_KIND_ORDER.map((kind) => {
          const tokens = SEARCH_HIT_KIND_TOKENS[kind];
          return (
            <span
              key={kind}
              className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap"
              style={{
                color: tokens.foreground,
                background: tokens.background,
                borderColor: tokens.border,
              }}
              title={`${tokens.label} — ${tokens.description}`}
            >
              <tokens.Icon size={12} />
              {tokens.shortLabel}
              <span className="font-mono opacity-80">{counts[kind]}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
