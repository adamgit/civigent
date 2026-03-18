/**
 * SectionActivityContext — tracks which section is hovered and/or actively edited.
 *
 * Scoped to pages that embed DocumentSectionRenderer (DocumentPage,
 * GovernanceDocumentPage). Not app-wide.
 *
 * Usage:
 *   - Wrap your section-rendering page with <SectionHoverProvider activeSectionIndex={focusedSectionIndex}>
 *   - In section renderers: const { setHoveredSection } = useSectionHover()
 *   - In gutter components: const { hoveredSection, activeSectionIndex } = useSectionHover()
 */

import { createContext, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SectionHoverContextValue } from "./sectionHoverUtils";

export const SectionHoverContext = createContext<SectionHoverContextValue | null>(null);

interface SectionHoverProviderProps {
  children: ReactNode;
  /** Current actively-edited section index, fed from focusedSectionIndex in useDocumentCrdt. */
  activeSectionIndex?: number | null;
}

export function SectionHoverProvider({ children, activeSectionIndex = null }: SectionHoverProviderProps) {
  const [hoveredSection, setHoveredSectionState] = useState<number | null>(null);
  const setHoveredSection = useCallback((index: number | null) => {
    setHoveredSectionState(index);
  }, []);
  const value = useMemo(
    () => ({ hoveredSection, activeSectionIndex, setHoveredSection }),
    [hoveredSection, activeSectionIndex, setHoveredSection],
  );
  return (
    <SectionHoverContext.Provider value={value}>
      {children}
    </SectionHoverContext.Provider>
  );
}
