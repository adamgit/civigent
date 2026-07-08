/**
 * DocumentSectionNav — right-side section index for the document view.
 *
 * Renders one row per heading of the live (CRDT/workspace) document structure as
 * a vertical spine with horizontal ticks. Tick length (and therefore the label's
 * indent) scales with the heading's nesting depth: H1 = shortest tick / least
 * indent, deeper = longer / more indented. The document title sits ABOVE the
 * spine in bold black, with a smaller left margin than the section rows.
 *
 * Highlight precedence per row:
 *   1. editing cursor section  → green
 *   2. top-of-viewport section → blue
 *   3. otherwise               → neutral
 *
 * Positioning: the component pins itself (fixed) so its left edge sits at the
 * right edge of the white paper (measured from `anchorRef`) and its top aligns
 * with the top of the paper, clamped below the topbar so it stays visible while
 * scrolling. Because it is viewport-anchored, when the window is too narrow to
 * show the full gutter the panel is simply clipped off the right edge — the user
 * widens the window to reveal it. All document data arrives via props.
 */

import { useLayoutEffect, useState } from "react";

export interface DocumentSectionNavItem {
  /** Stable backend-owned CRDT fragment identity — used for keys + scroll target. */
  fragmentKey: string;
  /** Heading text to display. */
  heading: string;
  /** Nesting depth (heading_path length); 1 = top level. Drives tick length. */
  depth: number;
  headingPath: string[];
}

export interface DocumentSectionNavProps {
  /** Document title — rendered as the bold header above the spine. */
  title: string;
  items: DocumentSectionNavItem[];
  /** Section currently at the top of the viewport (blue). */
  activeFragmentKey: string | null;
  /** Section containing the edit cursor while editing (green, overrides blue). */
  editingFragmentKey: string | null;
  onNavigate: (fragmentKey: string) => void;
  /** Scroll the document back to the very top (title click). */
  onNavigateToTop: () => void;
  /** The white paper element — the panel's left edge tracks its right edge and
   *  its top tracks the paper's top. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** The scroll container — re-measure position as it scrolls. */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
}

const PANEL_WIDTH = 200;
const GAP_FROM_PAPER = 12;
const TOPBAR_FALLBACK = 46;

const BASE_TICK_WIDTH = 14;
const WIDTH_PER_DEPTH = 9;
const MAX_VISUAL_DEPTH = 6;

const COLOR_SPINE = "var(--color-text-faint)";
const COLOR_NEUTRAL_LINE = "var(--color-text-faint)";
const COLOR_NEUTRAL_TEXT = "var(--color-text-muted)";
const COLOR_TITLE = "var(--color-text-primary)";
const COLOR_ACTIVE = "#2563eb"; // blue-600 — top of viewport
const COLOR_EDITING = "#15803d"; // green-700 — edit cursor section

function tickWidth(depth: number): number {
  const d = Math.min(Math.max(1, depth), MAX_VISUAL_DEPTH);
  return BASE_TICK_WIDTH + (d - 1) * WIDTH_PER_DEPTH;
}

function readTopbarHeight(): number {
  if (typeof window === "undefined") return TOPBAR_FALLBACK;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--spacing-topbar-h")
    .trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : TOPBAR_FALLBACK;
}

interface PanelPos {
  left: number;
  top: number;
}

function usePanelPosition(
  anchorRef: React.RefObject<HTMLElement | null>,
  scrollContainerRef: React.RefObject<HTMLElement | null>,
): PanelPos | null {
  const [pos, setPos] = useState<PanelPos | null>(null);

  // Runs on every render (no dep array) so banner toggles / layout shifts in the
  // page re-align the panel; setState is guarded to avoid an update loop.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const topbarBottom = readTopbarHeight() + 22;
      const next: PanelPos = {
        left: rect.right + GAP_FROM_PAPER,
        top: Math.max(topbarBottom, rect.top),
      };
      setPos((prev) =>
        prev && prev.left === next.left && prev.top === next.top ? prev : next,
      );
    };

    measure();

    let rafId = 0;
    const schedule = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        measure();
      });
    };

    const scroller = scrollContainerRef.current;
    scroller?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    ro?.observe(anchor);

    return () => {
      scroller?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  });

  return pos;
}

export function DocumentSectionNav({
  title,
  items,
  activeFragmentKey,
  editingFragmentKey,
  onNavigate,
  onNavigateToTop,
  anchorRef,
  scrollContainerRef,
}: DocumentSectionNavProps) {
  const pos = usePanelPosition(anchorRef, scrollContainerRef);

  if (items.length === 0) return null;

  return (
    <nav
      aria-label="Document sections"
      className="canvas-scroll"
      style={{
        position: "fixed",
        left: pos ? pos.left : -9999,
        top: pos ? pos.top : 0,
        width: PANEL_WIDTH,
        maxHeight: pos
          ? `calc(100vh - ${pos.top}px - var(--spacing-footer-h) - 16px)`
          : undefined,
        overflowY: "auto",
        overflowX: "hidden",
        zIndex: 20,
        fontFamily: "var(--font-ui)",
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {/* Document title — bold black, above the spine, smaller left margin */}
      <button
        type="button"
        onClick={onNavigateToTop}
        title={title}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          padding: "0 2px 8px",
          color: COLOR_TITLE,
        }}
      >
        <span
          aria-hidden="true"
          style={{ flex: "none", width: 7, height: 7, borderRadius: 1, background: COLOR_TITLE }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1.3,
          }}
        >
          {title}
        </span>
      </button>

      {/* Section rows — vertical spine with horizontal ticks */}
      <div style={{ position: "relative" }}>
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 5,
            top: -17,
            bottom: 11,
            width: 1.5,
            borderRadius: 1,
            background: COLOR_SPINE,
            zIndex: -1,
          }}
        />
        {items.map((item) => {
          const isEditing = editingFragmentKey === item.fragmentKey;
          const isActive = !isEditing && activeFragmentKey === item.fragmentKey;
          const emphasized = isEditing || isActive;
          const color = isEditing ? COLOR_EDITING : isActive ? COLOR_ACTIVE : COLOR_NEUTRAL_TEXT;
          const lineColor = isEditing
            ? COLOR_EDITING
            : isActive
            ? COLOR_ACTIVE
            : COLOR_NEUTRAL_LINE;
          return (
            <button
              key={item.fragmentKey}
              type="button"
              title={item.headingPath.join(" > ")}
              onClick={() => onNavigate(item.fragmentKey)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                textAlign: "left",
                padding: "3px 2px 3px 5px",
                color,
                transition: "color 120ms ease",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  flex: "none",
                  height: emphasized ? 3 : 2,
                  width: tickWidth(item.depth),
                  borderRadius: 2,
                  background: lineColor,
                  transition: "background-color 120ms ease, height 120ms ease",
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12.5,
                  fontWeight: emphasized ? 600 : 400,
                  lineHeight: 1.3,
                }}
              >
                {item.heading}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
