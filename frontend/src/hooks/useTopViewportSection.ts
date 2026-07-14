/**
 * useSectionViewportVisibility — how much of each document section is on-screen.
 *
 * Scans the section wrapper elements (tagged with `data-fragment-key` by
 * DocumentSectionRenderer) inside the given scroll container and returns a map
 * of fragment key → visible fraction:
 *   0     = fully off-screen
 *   1     = fully on-screen
 *   (0,1) = fraction of the section's height intersecting the viewport
 *
 * Recomputes on scroll (rAF-throttled), on resize, and whenever `revision`
 * changes (pass the live section count / a structural revision so the observer
 * re-syncs after the section list changes).
 */

import { useEffect, useState } from "react";

export type SectionVisibilityMap = Record<string, number>;

function intersectionRatio(
  elRect: DOMRectReadOnly,
  containerRect: DOMRectReadOnly,
): number {
  const top = Math.max(elRect.top, containerRect.top);
  const bottom = Math.min(elRect.bottom, containerRect.bottom);
  const visibleHeight = Math.max(0, bottom - top);
  if (elRect.height <= 0) return 0;
  // Round so subpixel scroll jitter does not thrash React state.
  return Math.round(Math.min(1, visibleHeight / elRect.height) * 100) / 100;
}

function visibilityMapsEqual(a: SectionVisibilityMap, b: SectionVisibilityMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function useSectionViewportVisibility(
  scrollContainerRef: React.RefObject<HTMLElement | null>,
  revision: number,
): SectionVisibilityMap {
  const [visibilityByFragmentKey, setVisibilityByFragmentKey] =
    useState<SectionVisibilityMap>({});

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let rafId = 0;

    const compute = () => {
      rafId = 0;
      const containerRect = container.getBoundingClientRect();
      const els = container.querySelectorAll<HTMLElement>("[data-fragment-key]");
      const next: SectionVisibilityMap = {};

      for (const el of els) {
        const key = el.getAttribute("data-fragment-key");
        if (!key) continue;
        next[key] = intersectionRatio(el.getBoundingClientRect(), containerRect);
      }

      setVisibilityByFragmentKey((prev) =>
        visibilityMapsEqual(prev, next) ? prev : next,
      );
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

  return visibilityByFragmentKey;
}
