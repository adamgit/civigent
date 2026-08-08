/**
 * The results list under the map.
 *
 * It renders EVERY hit it is given — the whole point of the map is that you
 * narrow by choosing a subtree, not by the page quietly deciding you have seen
 * enough. There is deliberately no pagination, no virtualization-with-cutoff,
 * and no "top N": if the list is long, that is information about the query.
 */
import type { SearchTextMatch } from "../../services/api-client";
import { SearchHitCards } from "./SearchHitCards";

export function SearchHitInspector({
  hits,
  selectedPath,
  onShowAll,
  highlightRegex,
}: {
  hits: readonly SearchTextMatch[];
  /** `null` = nothing selected, so these are all the results. */
  selectedPath: string | null;
  onShowAll: () => void;
  highlightRegex: RegExp | null;
}) {
  const countLabel = `${hits.length} result${hits.length === 1 ? "" : "s"}`;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-text-secondary">
          {selectedPath === null ? (
            <>
              Showing <strong>{countLabel}</strong> — all results
            </>
          ) : (
            <>
              Showing <strong>{countLabel}</strong> under{" "}
              <code className="font-mono text-[12px] text-text-primary">{selectedPath}</code>
            </>
          )}
        </span>
        {selectedPath === null ? null : (
          <button type="button" className="btn-secondary" style={{ height: 26 }} onClick={onShowAll}>
            Show all results
          </button>
        )}
      </div>

      {hits.length === 0 ? (
        <p style={{ color: "var(--color-text-muted)" }}>
          {selectedPath === null
            ? "No matches found."
            : "No results under this path in the current search."}
        </p>
      ) : (
        <SearchHitCards matches={hits} highlightRegex={highlightRegex} />
      )}
    </div>
  );
}
