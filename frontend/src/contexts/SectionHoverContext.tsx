/**
 * SectionActivityContext — tracks which section is hovered and/or actively edited.
 *
 * Scoped to pages that embed DocumentSectionRenderer (DocumentPage,
 * GovernanceDocumentPage). Not app-wide. Identity is the opaque FRAGMENT KEY —
 * render positions are never used as hover/active identity, so attribution and
 * gutter highlighting follow the same section across reorders.
 *
 * The setter lives in its own context because it is permanently stable while the
 * hovered/active keys change on every hover move: a row that only needs to
 * report hover must not re-render when some other row becomes hovered.
 *
 * Usage:
 *   - Wrap your section-rendering page with <SectionHoverProvider activeFragmentKey={focusedFragmentKey}>
 *   - In section renderers: const setHoveredFragmentKey = useSetHoveredFragmentKey()
 *   - In gutter components: const { hoveredFragmentKey, activeFragmentKey } = useSectionHover()
 */

import { createContext, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { SectionHoverContextValue, SetHoveredFragmentKey } from "./sectionHoverUtils";

export const SectionHoverContext = createContext<SectionHoverContextValue | null>(null);
export const SetHoveredFragmentKeyContext = createContext<SetHoveredFragmentKey | null>(null);

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
    () => ({ hoveredFragmentKey, activeFragmentKey }),
    [hoveredFragmentKey, activeFragmentKey],
  );
  return (
    <SetHoveredFragmentKeyContext.Provider value={setHoveredFragmentKey}>
      <SectionHoverContext.Provider value={value}>
        {children}
      </SectionHoverContext.Provider>
    </SetHoveredFragmentKeyContext.Provider>
  );
}
