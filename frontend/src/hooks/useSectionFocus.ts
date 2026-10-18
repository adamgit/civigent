import { useCallback, useEffect, useRef, useState } from "react";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import type { SectionArrowExit } from "../components/sectionEdge";
import { SectionId, type RenderSectionRef } from "../types/live-sections";

export interface UseSectionFocusParams {
  sections: readonly RenderSectionRef[];
  canFocusSection: (section: RenderSectionRef | undefined) => boolean;
  publishViewingSection: (fragmentKey: string) => void;
  readyEditors: Set<string>;
  editorRefs: React.MutableRefObject<Map<string, MilkdownEditorHandle>>;
}

export interface PendingFragmentCaretTarget {
  fragmentKey: string;
  position: "start" | "end";
  coords?: { x: number; y: number };
  column?: number | null;
}

export interface UseSectionFocusReturn {
  bootstrapFocusedSectionIndex: number | null;
  setBootstrapFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  pendingCaretTargetRef: React.MutableRefObject<PendingFragmentCaretTarget | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  handleCursorExit: (sectionIndex: number, exit: SectionArrowExit) => void;
}

export function useSectionFocus({
  sections,
  canFocusSection,
  publishViewingSection,
  readyEditors,
  editorRefs,
}: UseSectionFocusParams): UseSectionFocusReturn {
  const [bootstrapFocusedSectionIndex, setBootstrapFocusedSectionIndex] = useState<number | null>(null);
  const pendingCaretTargetRef = useRef<PendingFragmentCaretTarget | null>(null);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (bootstrapFocusedSectionIndex === null) {
      pendingCaretTargetRef.current = null;
    }
  }, [bootstrapFocusedSectionIndex]);

  const publishViewingSectionAtIndex = useCallback((sectionIndex: number) => {
    const section = sections[sectionIndex];
    if (!section) return;
    publishViewingSection(SectionId.text(section.id));
  }, [sections, publishViewingSection]);

  const handleCursorExit = useCallback((sectionIndex: number, exit: SectionArrowExit) => {
    const targetIndex = exit.toward === "up" ? sectionIndex - 1 : sectionIndex + 1;
    if (targetIndex < 0 || targetIndex >= sections.length) return;

    const targetSection = sections[targetIndex];
    if (!canFocusSection(targetSection)) return;

    setBootstrapFocusedSectionIndex(targetIndex);
    pendingCaretTargetRef.current = {
      fragmentKey: SectionId.text(targetSection.id),
      position: exit.toward === "up" ? "end" : "start",
      column: exit.column,
    };
    publishViewingSectionAtIndex(targetIndex);
  }, [sections, publishViewingSectionAtIndex, canFocusSection]);

  useEffect(() => {
    if (!pendingCaretTargetRef.current) return;
    const target = pendingCaretTargetRef.current;
    if (!readyEditors.has(target.fragmentKey)) return;

    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      const handle = editorRefs.current.get(target.fragmentKey);
      if (handle) {
        if (target.coords) {
          handle.focusAtCoords(target.coords.x, target.coords.y);
        } else {
          handle.focus(target.position, target.column ?? null);
        }
      }
      pendingCaretTargetRef.current = null;
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [bootstrapFocusedSectionIndex, readyEditors, editorRefs]);

  return {
    bootstrapFocusedSectionIndex,
    setBootstrapFocusedSectionIndex,
    pendingCaretTargetRef,
    mouseDownPosRef,
    handleCursorExit,
  };
}
