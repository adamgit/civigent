/**
 * Treemap view: area = how many hits live under a node.
 *
 * Where the folder map answers "what is the shape of the tree", this answers
 * "where is the weight" — the folder holding most of the matches is physically
 * the biggest thing on screen. Fill comes from the dominant kind in the subtree,
 * so a block of orange reads as "these matched on folder names, not content".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchHitKind } from "../../services/api-client";
import type { SearchTreeNode } from "./search-hit-forest";
import { SEARCH_HIT_KIND_ORDER, SEARCH_HIT_KIND_TOKENS } from "./search-hit-kinds";
import { buildTreemapRects } from "./search-treemap-layout";

/** Below this a rectangle cannot hold readable text, so the label is dropped. */
const LABEL_MIN_WIDTH_PX = 46;
const LABEL_MIN_HEIGHT_PX = 18;

function dominantKind(node: SearchTreeNode): SearchHitKind {
  let winner: SearchHitKind = SEARCH_HIT_KIND_ORDER[0];
  let best = -1;
  for (const kind of SEARCH_HIT_KIND_ORDER) {
    const count = node.descendantCounts[kind];
    if (count > best) {
      best = count;
      winner = kind;
    }
  }
  return winner;
}

function rectTitle(node: SearchTreeNode): string {
  const parts = SEARCH_HIT_KIND_ORDER.filter((kind) => node.descendantCounts[kind] > 0).map(
    (kind) => `${node.descendantCounts[kind]} ${SEARCH_HIT_KIND_TOKENS[kind].label.toLowerCase()}`,
  );
  return `${node.path}\n${node.totalDescendants} hit${node.totalDescendants === 1 ? "" : "s"}${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`;
}

export function SearchTreemap({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: SearchTreeNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Both dimensions are measured: the treemap fills whatever the map column
  // gives it, which is the height left over after the page's other rows.
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);
    const rect = element.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
    return () => observer.disconnect();
  }, []);

  const rects = useMemo(
    () =>
      size.width <= 0 || size.height <= 0
        ? []
        : buildTreemapRects(tree, { x: 0, y: 0, w: size.width, h: size.height }),
    [tree, size],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-lg border"
      style={{
        borderColor: "var(--color-footer-border)",
        background: "var(--color-page-bg)",
      }}
    >
      {rects.map((rect) => {
        const tokens = SEARCH_HIT_KIND_TOKENS[dominantKind(rect.node)];
        const selected = selectedPath === rect.node.path;
        const showLabel = rect.w >= LABEL_MIN_WIDTH_PX && rect.h >= LABEL_MIN_HEIGHT_PX;
        return (
          <button
            key={`${rect.node.path}:${rect.depth}`}
            type="button"
            aria-pressed={selected}
            aria-label={`${rect.node.path}, ${rect.node.totalDescendants} hits`}
            onClick={() => onSelect(rect.node.path)}
            title={rectTitle(rect.node)}
            className="absolute overflow-hidden text-left transition-[filter] hover:brightness-95"
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
              background: tokens.background,
              border: `${selected ? 2 : 1}px solid ${selected ? "var(--color-text-primary)" : tokens.border}`,
              color: tokens.foreground,
              padding: "2px 4px",
            }}
          >
            {showLabel ? (
              <span className="block truncate text-[11px] font-medium leading-none">
                {rect.node.label}
                <span className="font-mono opacity-75"> {rect.node.totalDescendants}</span>
              </span>
            ) : null}
          </button>
        );
      })}
      {rects.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-text-muted">
          Nothing to map.
        </div>
      ) : null}
    </div>
  );
}
