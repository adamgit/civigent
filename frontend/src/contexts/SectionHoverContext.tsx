/**
 * SectionActivityContext — tracks which section is hovered and/or actively edited.
 *
 * Scoped to pages that embed DocumentSectionRenderer (DocumentPage,
 * GovernanceDocumentPage). Not app-wide. Identity is the opaque FRAGMENT KEY —
 * render positions are never used as hover/active identity, so attribution and
 * gutter highlighting follow the same section across reorders.
 *
 * Usage:
 *   - Wrap your section-rendering page with <SectionHoverProvider activeFragmentKey={focusedFragmentKey}>
 *   - In section renderers: const { setHoveredFragmentKey } = useSectionHover()
 *   - In gutter components: const { hoveredFragmentKey, activeFragmentKey } = useSectionHover()
 */

import { createContext, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SectionHoverContextValue } from "./sectionHoverUtils";

export const SectionHoverContext = createContext<SectionHoverContextValue | null>(null);

interface SectionHoverProviderProps {
  children: ReactNode;
  /** Fragment key of the currently focused/edited section (page focus identity). */
  activeFragmentKey?: string | null;
}

export function SectionHoverProvider({ children, activeFragmentKey = null }: SectionHoverProviderProps) {
  const [hoveredFragmentKey, setHoveredFragmentKeyState] = useState<string | null>(null);
  const setHoveredFragmentKey = useCallback((fragmentKey: string | null) => {
    setHoveredFragmentKeyState(fragmentKey);
  }, []);
  const value = useMemo(
    () => ({ hoveredFragmentKey, activeFragmentKey, setHoveredFragmentKey }),
    [hoveredFragmentKey, activeFragmentKey, setHoveredFragmentKey],
  );
  return (
    <SectionHoverContext.Provider value={value}>
      {children}
    </SectionHoverContext.Provider>
  );
}
