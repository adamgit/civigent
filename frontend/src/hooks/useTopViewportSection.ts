/**
 * useTopViewportSection — detect which document section is currently at the top
 * of the scroll viewport.
 *
 * Scans the section wrapper elements (tagged with `data-fragment-key` by
 * DocumentSectionRenderer) inside the given scroll container and returns the
 * fragment key of the last section whose top edge is at or above the container's
 * top edge — i.e. the section the top of the viewport is currently inside.
 *
 * Recomputes on scroll (rAF-throttled), on resize, and whenever `revision`
 * changes (pass the live section count / a structural revision so the observer
 * re-syncs after the section list changes).
 */

import { useEffect, useState } from "react";

const TOP_THRESHOLD_PX = 8;

export function useTopViewportSection(
  scrollContainerRef: React.RefObject<HTMLElement | null>,
  revision: number,
): string | null {
  const [activeFragmentKey, setActiveFragmentKey] = useState<string | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let rafId = 0;

    const compute = () => {
      rafId = 0;
      const containerTop = container.getBoundingClientRect().top;
      const els = container.querySelectorAll<HTMLElement>("[data-fragment-key]");
      let current: string | null = null;
      for (const el of els) {
        const top = el.getBoundingClientRect().top;
        if (top - containerTop <= TOP_THRESHOLD_PX) {
          current = el.getAttribute("data-fragment-key");
        } else {
          break;
        }
      }
      // Scrolled above the first section — highlight the first one.
      if (current === null && els.length > 0) {
        current = els[0].getAttribute("data-fragment-key");
      }
      setActiveFragmentKey((prev) => (prev === current ? prev : current));
    };

    const schedule = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(compute);
    };

    compute();
    container.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, [scrollContainerRef, revision]);

  return activeFragmentKey;
}
