/**
 * DocumentPaperStickyHeader — compact pinned bar that replaces
 * {@link DocumentPaperHeader} once the in-flow header scrolls out of view.
 *
 * Positioned with `position: fixed` against the canvas scrollport so it cannot
 * scroll away. Visibility is a 0..1 scroll-linked progress (no delayed CSS
 * transition). Scroll math lives here so the document page does not re-render
 * on every frame.
 *
 * Only title + {@link DocumentPresenceActivity}. flex-wrap keeps activity on
 * the title line when space allows, and drops it underneath for long titles.
 */

import { useEffect, useState, type RefObject } from "react";
import type { DocumentActivityEvent } from "../types/shared.js";
import type { DocumentPresenceModel } from "../presence/document-presence-model";
import { DocumentPresenceActivity } from "./DocumentPresenceActivity";

interface StickyGeometry {
  top: number;
  left: number;
  width: number;
}

export interface DocumentPaperStickyHeaderProps {
  title: string;
  presenceModel: DocumentPresenceModel;
  currentUserId: string | null;
  documentActivity: DocumentActivityEvent | null;
  scrollContainerRef: RefObject<HTMLElement | null>;
  paperHeaderRef: RefObject<HTMLElement | null>;
  paperRef: RefObject<HTMLElement | null>;
}

export function DocumentPaperStickyHeader({
  title,
  presenceModel,
  currentUserId,
  documentActivity,
  scrollContainerRef,
  paperHeaderRef,
  paperRef,
}: DocumentPaperStickyHeaderProps): JSX.Element | null {
  const [progress, setProgress] = useState(0);
  const [geometry, setGeometry] = useState<StickyGeometry | null>(null);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      const header = paperHeaderRef.current;
      const paper = paperRef.current;
      if (!header || !paper) {
        setProgress(0);
        setGeometry(null);
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const paperRect = paper.getBoundingClientRect();
      const range = Math.max(1, headerRect.height);
      const scrolledOut = rootRect.top - headerRect.top;
      const nextProgress = Math.min(1, Math.max(0, scrolledOut / range));
      setProgress((prev) => (Math.abs(prev - nextProgress) < 0.001 ? prev : nextProgress));
      setGeometry((prev) => {
        const next = {
          top: rootRect.top,
          left: paperRect.left,
          width: paperRect.width,
        };
        if (
          prev &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.width === next.width
        ) {
          return prev;
        }
        return next;
      });
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };

    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollContainerRef, paperHeaderRef, paperRef]);

  if (!geometry || progress <= 0) return null;

  const clamped = Math.min(1, Math.max(0, progress));
  const interactive = clamped > 0.5;

  return (
    <button
      type="button"
      className="doc-paper-sticky-header"
      data-testid="doc-paper-sticky-header"
      aria-hidden={clamped < 0.05}
      aria-label="Scroll to top of document"
      title="Scroll to top"
      disabled={!interactive}
      onClick={() => {
        scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }}
      style={{
        top: geometry.top,
        left: geometry.left,
        width: geometry.width,
        opacity: clamped,
        transform: `translateY(${(1 - clamped) * -6}px)`,
        boxShadow: `0 2px 6px rgba(26, 22, 16, ${0.06 * clamped})`,
        pointerEvents: interactive ? "auto" : "none",
      }}
    >
      <div className="doc-paper-sticky-header__row">
        <h2 className="doc-paper-sticky-header__title">{title}</h2>
        <DocumentPresenceActivity
          model={presenceModel}
          currentUserId={currentUserId}
          activity={documentActivity}
        />
      </div>
    </button>
  );
}
