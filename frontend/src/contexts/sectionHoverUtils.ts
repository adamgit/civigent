import { useContext } from "react";
import { SectionHoverContext } from "./SectionHoverContext";

export interface SectionHoverContextValue {
  /** Fragment key of the hovered section wrapper (identity, never position). */
  hoveredFragmentKey: string | null;
  /** Fragment key of the actively focused/edited section. */
  activeFragmentKey: string | null;
  setHoveredFragmentKey: (fragmentKey: string | null) => void;
}

export function useSectionHover(): SectionHoverContextValue {
  const ctx = useContext(SectionHoverContext);
  if (!ctx) {
    // Return a no-op fallback when used outside a provider
    return { hoveredFragmentKey: null, activeFragmentKey: null, setHoveredFragmentKey: () => {} };
  }
  return ctx;
}
