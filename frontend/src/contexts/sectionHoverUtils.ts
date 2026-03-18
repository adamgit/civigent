import { useContext } from "react";
import { SectionHoverContext } from "./SectionHoverContext";

export interface SectionHoverContextValue {
  hoveredSection: number | null;
  activeSectionIndex: number | null;
  setHoveredSection: (index: number | null) => void;
}

export function useSectionHover(): SectionHoverContextValue {
  const ctx = useContext(SectionHoverContext);
  if (!ctx) {
    // Return a no-op fallback when used outside a provider
    return { hoveredSection: null, activeSectionIndex: null, setHoveredSection: () => {} };
  }
  return ctx;
}
