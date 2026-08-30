import { useContext } from "react";
import { SectionHoverContext, SetHoveredFragmentKeyContext } from "./SectionHoverContext";

export type SetHoveredFragmentKey = (fragmentKey: string | null) => void;

export interface SectionHoverContextValue {
  /** Fragment key of the hovered section wrapper (identity, never position). */
  hoveredFragmentKey: string | null;
  /** Fragment key of the actively focused/edited section. */
  activeFragmentKey: string | null;
}

const NO_OP_SET_HOVERED: SetHoveredFragmentKey = () => {};

export function useSectionHover(): SectionHoverContextValue {
  const ctx = useContext(SectionHoverContext);
  if (!ctx) {
    // Return a no-op fallback when used outside a provider
    return { hoveredFragmentKey: null, activeFragmentKey: null };
  }
  return ctx;
}

export function useSetHoveredFragmentKey(): SetHoveredFragmentKey {
  return useContext(SetHoveredFragmentKeyContext) ?? NO_OP_SET_HOVERED;
}
