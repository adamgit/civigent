/**
 * DocumentSectionNav — right-side section index for the document view.
 *
 * Renders one row per heading of the live (CRDT/workspace) document structure as
 * a vertical spine with horizontal ticks. Tick length (and therefore the label's
 * indent) scales with the ATX heading level: H1 = shortest tick / least indent,
 * H2–H6 = progressively longer / more indented. The document title sits ABOVE
 * the spine in bold black, with a smaller left margin than the section rows.
 *
 * Highlight precedence per row:
 *   1. editing cursor section  → green
 *   2. otherwise               → visibility blend:
 *        fully off-screen → mid-grey
 *        fully on-screen  → warm amber (--color-agent2)
 *        partial          → color-mix between the two by visible fraction
 *
 * Positioning: the component pins itself (fixed) from the paper's right edge
 * outward with a minimum width of 140px. Wider gutters use the available space;
 * when the right gutter is narrower than 140px the panel keeps that minimum and
 * the page's horizontal scroll reveals it. All document data arrives via props.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { SectionVisibilityMap } from "../hooks/useTopViewportSection";
import type { HeadingLevel } from "../types/shared";

export interface DocumentSectionNavItem {
  /** Stable backend-owned CRDT fragment identity — used for keys + scroll target. */
  fragmentKey: string;
  /** Heading text to display. */
  heading: string;
  headingLevel: HeadingLevel;
  headingPath: string[];
}

export interface DocumentSectionNavProps {
  /** Document title — rendered as the bold header above the spine. */
  title: string;
  items: DocumentSectionNavItem[];
  /** Section containing the edit cursor while editing (green). */
  editingFragmentKey: string | null;
  /** Per-section on-screen fraction (0 = off, 1 = full, between = partial). */
  visibilityByFragmentKey: SectionVisibilityMap;
  onNavigate: (fragmentKey: string) => void;
  /** Scroll the document back to the very top (title click). */
  onNavigateToTop: () => void;
  /** The white paper element — the panel's left edge tracks its right edge and
   *  its top tracks the paper's top. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** The scroll container — re-measure position as it scrolls. */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
}

const TOPBAR_FALLBACK = 46;
const MIN_PANEL_WIDTH_PX = 140;

const BASE_TICK_WIDTH = 14;
const WIDTH_PER_DEPTH = 9;
const MAX_VISUAL_DEPTH = 6;

const COLOR_SPINE = "var(--color-text-faint)";
const COLOR_OFFSCREEN = "var(--color-text-muted)";
const COLOR_ONSCREEN = "var(--color-agent2)"; // warm amber already in the site palette
const COLOR_TITLE = "var(--color-text-primary)";
const COLOR_EDITING = "#15803d"; // green-700 — edit cursor section

// Match the section-row styles below: padding-top 3 + half of one 12.5×1.3 line.
// Spine must end here on the LAST row so multi-line labels do not leave a dangling
// segment below the first-line tick.
const ROW_PADDING_TOP_PX = 3;
const LABEL_FONT_SIZE_PX = 12.5;
const LABEL_LINE_HEIGHT = 1.3;
const SPINE_END_FROM_LAST_TOP_PX =
  ROW_PADDING_TOP_PX + (LABEL_FONT_SIZE_PX * LABEL_LINE_HEIGHT) / 2;

function tickWidth(headingLevel: HeadingLevel): number {
  const d = Math.min(Math.max(1, headingLevel), MAX_VISUAL_DEPTH);
  return BASE_TICK_WIDTH + (d - 1) * WIDTH_PER_DEPTH;
}

/** Mid-grey ↔ warm-amber blend driven by how much of the section is on-screen. */
function visibilityColor(ratio: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  return `color-mix(in srgb, ${COLOR_ONSCREEN} ${pct}%, ${COLOR_OFFSCREEN})`;
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
  width: number;
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
      const scroller = scrollContainerRef.current;
      const scrollerRect = scroller?.getBoundingClientRect();
      const scrollerStyle = scroller ? getComputedStyle(scroller) : null;
      const scrollerPaddingRight = scrollerStyle
        ? Number.parseFloat(scrollerStyle.paddingRight) || 0
        : 0;
      const right = scrollerRect
        ? scrollerRect.right - scrollerPaddingRight
        : window.innerWidth;
      const topbarBottom = readTopbarHeight();
      const available = Math.max(0, right - rect.right);
      const next: PanelPos = {
        left: rect.right,
        top: Math.max(topbarBottom, rect.top),
        width: Math.max(MIN_PANEL_WIDTH_PX, available),
      };
      setPos((prev) =>
        prev && prev.left === next.left && prev.top === next.top && prev.width === next.width ? prev : next,
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
    if (scroller) ro?.observe(scroller);

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
  editingFragmentKey,
  visibilityByFragmentKey,
  onNavigate,
  onNavigateToTop,
  anchorRef,
  scrollContainerRef,
}: DocumentSectionNavProps) {
  const pos = usePanelPosition(anchorRef, scrollContainerRef);
  const navRef = useRef<HTMLElement | null>(null);
  const lastItemRef = useRef<HTMLButtonElement | null>(null);
  const [spineBottomPx, setSpineBottomPx] = useState(SPINE_END_FROM_LAST_TOP_PX);

  // End the spine at mid-first-line of the last entry (where the tick sits), not
  // mid-entry — wrapped labels are taller than one line.
  useLayoutEffect(() => {
    const el = lastItemRef.current;
    if (!el) return;

    const measure = () => {
      const next = Math.max(0, el.offsetHeight - SPINE_END_FROM_LAST_TOP_PX);
      setSpineBottomPx((prev) => (prev === next ? prev : next));
    };

    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [items]);

  // The nav is a fixed overlay with its own overflow box, which would otherwise
  // trap wheel events (often scrolling nothing). Forward wheel to the document
  // scroller when the nav itself has no scroll room in that direction.
  // Do not call preventDefault: wheel listeners are often passive, and
  // preventDefault then spams "Unable to preventDefault inside passive event
  // listener". scrollBy alone is enough to move the page.
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const setNavRef = useCallback((node: HTMLElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    navRef.current = node;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      const scroller = scrollContainerRef.current;
      if (!scroller) return;

      const canScrollNav =
        node.scrollHeight > node.clientHeight + 1
        && (
          (event.deltaY < 0 && node.scrollTop > 0)
          || (event.deltaY > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1)
        );
      if (canScrollNav) return;

      scroller.scrollBy({ top: event.deltaY, left: event.deltaX });
    };

    node.addEventListener("wheel", onWheel, { passive: true });
    wheelCleanupRef.current = () => node.removeEventListener("wheel", onWheel);
  }, [scrollContainerRef]);

  if (items.length === 0) return null;

  const lastIndex = items.length - 1;

  return (
    <nav
      ref={setNavRef}
      aria-label="Document sections"
      className="canvas-scroll doc-section-nav"
      style={{
        position: "fixed",
        left: pos ? pos.left : -9999,
        top: pos ? pos.top : 0,
        width: pos ? pos.width : 0,
        boxSizing: "border-box",
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
        className="doc-section-nav__item"
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
          className="doc-section-nav__label"
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

      {/* Section rows — vertical spine with horizontal ticks.
       *  Spine ends at mid-first-line of the last row (tick height), so wrapped
       *  labels do not leave a dangling segment below the tick. */}
      <div style={{ position: "relative" }}>
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 5,
            top: -17,
            bottom: spineBottomPx,
            width: 1.5,
            borderRadius: 1,
            background: COLOR_SPINE,
            zIndex: -1,
          }}
        />
        {items.map((item, index) => {
          const isEditing = editingFragmentKey === item.fragmentKey;
          const visibility = visibilityByFragmentKey[item.fragmentKey] ?? 0;
          const color = isEditing ? COLOR_EDITING : visibilityColor(visibility);
          return (
            <button
              key={item.fragmentKey}
              ref={index === lastIndex ? lastItemRef : undefined}
              type="button"
              className="doc-section-nav__item"
              title={item.headingPath.join(" > ")}
              onClick={() => onNavigate(item.fragmentKey)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                width: "100%",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                textAlign: "left",
                padding: `${ROW_PADDING_TOP_PX}px 2px 3px 5px`,
                color,
                transition: "color 120ms ease",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  flex: "none",
                  height: isEditing ? 3 : 2,
                  width: tickWidth(item.headingLevel),
                  marginTop: 7,
                  borderRadius: 2,
                  background: color,
                  transition: "background-color 120ms ease, height 120ms ease",
                }}
              />
              <span
                className="doc-section-nav__label"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                  fontSize: LABEL_FONT_SIZE_PX,
                  fontWeight: isEditing ? 600 : 400,
                  lineHeight: LABEL_LINE_HEIGHT,
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
