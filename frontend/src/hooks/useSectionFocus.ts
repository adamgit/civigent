import { useCallback, useEffect, useRef, useState } from "react";
import { type MilkdownEditorHandle } from "../components/MilkdownEditor";
import { SectionId, type RenderSectionRef } from "../types/live-sections";
import { resolveRetargetPmPos, type RetargetCaretPlacement } from "../pages/caret-recovery";

export interface UseSectionFocusParams {
  sections: readonly RenderSectionRef[];
  canFocusSection: (section: RenderSectionRef | undefined) => boolean;
  publishViewingSection: (fragmentKey: string) => void;
  readyEditors: Set<string>;
  editorRefs: React.MutableRefObject<Map<string, MilkdownEditorHandle>>;
}

export type PendingFragmentCaretTarget =
  | {
      fragmentKey: string;
      position: "start" | "end";
      coords?: { x: number; y: number };
    }
  | {
      fragmentKey: string;
      position: "retarget";
      placement: RetargetCaretPlacement;
    };

export interface UseSectionFocusReturn {
  bootstrapFocusedSectionIndex: number | null;
  setBootstrapFocusedSectionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  pendingCaretTargetRef: React.MutableRefObject<PendingFragmentCaretTarget | null>;
  mouseDownPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  handleCursorExit: (sectionIndex: number, direction: "up" | "down") => void;
  setRetargetCaretTarget: (target: Extract<PendingFragmentCaretTarget, { position: "retarget" }>) => void;
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
  const [caretTargetVersion, setCaretTargetVersion] = useState(0);

  useEffect(() => {
    if (bootstrapFocusedSectionIndex === null && pendingCaretTargetRef.current?.position !== "retarget") {
      pendingCaretTargetRef.current = null;
    }
  }, [bootstrapFocusedSectionIndex]);

  const setRetargetCaretTarget = useCallback(
    (target: Extract<PendingFragmentCaretTarget, { position: "retarget" }>) => {
      pendingCaretTargetRef.current = target;
      setCaretTargetVersion((v) => v + 1);
    },
    [],
  );

  const publishViewingSectionAtIndex = useCallback((sectionIndex: number) => {
    const section = sections[sectionIndex];
    if (!section) return;
    publishViewingSection(SectionId.text(section.id));
  }, [sections, publishViewingSection]);

  const handleCursorExit = useCallback((sectionIndex: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? sectionIndex - 1 : sectionIndex + 1;
    if (targetIndex < 0 || targetIndex >= sections.length) return;

    const targetSection = sections[targetIndex];
    if (!canFocusSection(targetSection)) return;

    setBootstrapFocusedSectionIndex(targetIndex);
    pendingCaretTargetRef.current = {
      fragmentKey: SectionId.text(targetSection.id),
      position: direction === "up" ? "end" : "start",
    };
    publishViewingSectionAtIndex(targetIndex);
  }, [sections, publishViewingSectionAtIndex, canFocusSection]);

  useEffect(() => {
    if (!pendingCaretTargetRef.current) return;
    const target = pendingCaretTargetRef.current;
    if (!readyEditors.has(target.fragmentKey)) return;

    const raf = requestAnimationFrame(() => {
      const handle = editorRefs.current.get(target.fragmentKey);
      if (handle) {
        if (target.position === "retarget") {
          const view = handle.getView();
          if (view) {
            handle.focusAtPos(resolveRetargetPmPos(view.state.doc, target.placement));
          } else {
            handle.focus("start");
          }
        } else if (target.coords) {
          handle.focusAtCoords(target.coords.x, target.coords.y);
        } else {
          handle.focus(target.position);
        }
      }
      pendingCaretTargetRef.current = null;
    });

    return () => cancelAnimationFrame(raf);
  }, [bootstrapFocusedSectionIndex, caretTargetVersion, readyEditors, editorRefs]);

  return {
    bootstrapFocusedSectionIndex,
    setBootstrapFocusedSectionIndex,
    pendingCaretTargetRef,
    mouseDownPosRef,
    handleCursorExit,
    setRetargetCaretTarget,
  };
}
