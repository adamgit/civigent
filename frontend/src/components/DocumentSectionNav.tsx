/**
 * DocumentSectionNav — right-side section index for the document view.
 *
 * Renders one row per heading of the live (CRDT/workspace) document structure as
 * plain text, indented a little per ATX heading level. The document title sits
 * above the rows in bold.
 *
 * Sections claimed by the bound shared-draft proposal (unpublished changes) are
 * drawn in a rounded accent box with accent text and an edit icon. Every row
 * carries the same border width and icon slot, so a section entering or leaving
 * the draft never changes the label's wrap width.
 *
 * Positioning: the component pins itself (fixed) from the paper's right edge
 * outward with a minimum width of 140px. Wider gutters use the available space;
 * when the right gutter is narrower than 140px the panel keeps that minimum and
 * the page's horizontal scroll reveals it. All document data arrives via props.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  /** Document title — rendered as the bold header above the rows. */
  title: string;
  items: DocumentSectionNavItem[];
  /** Section containing the edit cursor while editing. */
  editingFragmentKey: string | null;
  /** Per-section on-screen fraction (0 = off, 1 = full, between = partial). */
  visibilityByFragmentKey: SectionVisibilityMap;
  /** Fragment keys of sections with unpublished shared-draft changes (accent box). */
  changedFragmentKeys: ReadonlySet<string>;
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

const MAX_VISUAL_DEPTH = 6;

const COLOR_OFFSCREEN = "var(--color-text-muted)";
const COLOR_ONSCREEN = "var(--color-agent2)"; // warm amber already in the site palette
const COLOR_TITLE = "var(--color-text-primary)";
const COLOR_ROW = "var(--color-text-secondary)";
// Same accent family as the shared-draft banner.
const COLOR_CHANGED_TEXT = "var(--color-accent-text)";
const COLOR_CHANGED_BG = "var(--color-accent-light)";
const COLOR_CHANGED_BORDER = "var(--color-accent-border)";

const LABEL_FONT_SIZE_PX = 12.5;
const LABEL_LINE_HEIGHT = 1.3;

function headingIndentPx(headingLevel: HeadingLevel, perLevelPx: number): number {
  const depth = Math.min(Math.max(1, headingLevel), MAX_VISUAL_DEPTH);
  return (depth - 1) * perLevelPx;
}

function EditIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.6 2.9 13.1 5.4 5.6 12.9 2.6 13.4 3.1 10.4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M9.2 4.3 11.7 6.8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
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

export interface DocumentSectionNavListProps {
  title: string;
  items: DocumentSectionNavItem[];
  editingFragmentKey: string | null;
  visibilityByFragmentKey: SectionVisibilityMap;
  changedFragmentKeys: ReadonlySet<string>;
  onNavigate: (fragmentKey: string) => void;
  onNavigateToTop: () => void;
  /** Overlay uses larger type and padding for touch; gutter stays compact. */
  density?: "gutter" | "overlay";
}

function listMetrics(density: "gutter" | "overlay") {
  const overlay = density === "overlay";
  const fontSize = overlay ? 16 : LABEL_FONT_SIZE_PX;
  return {
    fontSize,
    titleSize: overlay ? 17 : 13,
    titlePadBottom: overlay ? 12 : 8,
    padY: overlay ? 9 : 4,
    padX: overlay ? 10 : 8,
    indentPerLevel: overlay ? 14 : 10,
    rowGap: overlay ? 4 : 2,
    iconSize: Math.round(fontSize * 1.05),
    iconGap: overlay ? 8 : 6,
  };
}

export function DocumentSectionNavList({
  title,
  items,
  changedFragmentKeys,
  onNavigate,
  onNavigateToTop,
  density = "gutter",
}: DocumentSectionNavListProps) {
  const metrics = listMetrics(density);

  return (
    <>
      <button
        type="button"
        className="doc-section-nav__item"
        onClick={onNavigateToTop}
        title={title}
        style={{
          display: "flex",
          alignItems: "center",
          width: "100%",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          padding: `0 ${metrics.padX + 1}px ${metrics.titlePadBottom}px`,
          color: COLOR_TITLE,
        }}
      >
        <span
          className="doc-section-nav__label"
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: metrics.titleSize,
            fontWeight: 700,
            lineHeight: 1.3,
          }}
        >
          {title}
        </span>
      </button>

      <div style={{ display: "flex", flexDirection: "column", gap: metrics.rowGap }}>
        {items.map((item) => {
          const isChanged = changedFragmentKeys.has(item.fragmentKey);
          const pathLabel = item.headingPath.join(" > ");
          return (
            <button
              key={item.fragmentKey}
              type="button"
              className="doc-section-nav__item"
              title={isChanged ? `${pathLabel} — unpublished changes` : pathLabel}
              onClick={() => onNavigate(item.fragmentKey)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: metrics.iconGap,
                width: "100%",
                border: `1px solid ${isChanged ? COLOR_CHANGED_BORDER : "transparent"}`,
                borderRadius: 6,
                background: isChanged ? COLOR_CHANGED_BG : "transparent",
                cursor: "pointer",
                textAlign: "left",
                padding: `${metrics.padY}px ${metrics.padX}px ${metrics.padY}px ${
                  metrics.padX + headingIndentPx(item.headingLevel, metrics.indentPerLevel)
                }px`,
                color: isChanged ? COLOR_CHANGED_TEXT : COLOR_ROW,
              }}
            >
              <span
                className="doc-section-nav__label"
                style={{
                  flex: "0 1 auto",
                  minWidth: 0,
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                  fontSize: metrics.fontSize,
                  fontWeight: isChanged ? 600 : 400,
                  lineHeight: LABEL_LINE_HEIGHT,
                }}
              >
                {item.heading}
                {isChanged ? <span className="sr-only"> (unpublished changes)</span> : null}
              </span>
              <span
                aria-hidden="true"
                style={{
                  flex: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  width: metrics.iconSize,
                  height: metrics.fontSize * LABEL_LINE_HEIGHT,
                }}
              >
                {isChanged ? <EditIcon size={metrics.iconSize} /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export interface DocumentSectionNavOverlayProps extends DocumentSectionNavListProps {
  onClose: () => void;
}

export function DocumentSectionNavOverlay({ onClose, ...listProps }: DocumentSectionNavOverlayProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="Document sections"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        background: "var(--color-page-bg)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--font-ui)",
      }}
    >
      <div
        style={{
          flex: "none",
          padding: "12px 16px 14px",
          borderBottom: "1px solid rgba(0, 0, 0, 0.06)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700, color: COLOR_TITLE }}>Sections</span>
          <button
            type="button"
            aria-label="Close sections"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 22,
              lineHeight: 1,
              width: 36,
              height: 36,
              padding: 0,
              color: "var(--color-text-muted)",
            }}
          >
            ×
          </button>
        </div>
        <p
          style={{
            margin: "6px 0 0",
            fontSize: 13,
            fontStyle: "italic",
            lineHeight: 1.4,
            color: "var(--color-text-muted)",
          }}
        >
          Tap a heading to go to that place in the document.
        </p>
      </div>
      <div
        className="canvas-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "16px 16px 32px" }}
      >
        <DocumentSectionNavList {...listProps} density="overlay" />
      </div>
    </div>
  );
}

export function DocumentSectionNav({
  title,
  items,
  editingFragmentKey,
  visibilityByFragmentKey,
  changedFragmentKeys,
  onNavigate,
  onNavigateToTop,
  anchorRef,
  scrollContainerRef,
}: DocumentSectionNavProps) {
  const pos = usePanelPosition(anchorRef, scrollContainerRef);
  const navRef = useRef<HTMLElement | null>(null);

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
      <DocumentSectionNavList
        title={title}
        items={items}
        editingFragmentKey={editingFragmentKey}
        visibilityByFragmentKey={visibilityByFragmentKey}
        changedFragmentKeys={changedFragmentKeys}
        onNavigate={onNavigate}
        onNavigateToTop={onNavigateToTop}
      />
    </nav>
  );
}
