import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import { sectionExitForArrow, type SectionArrowExit } from "./sectionEdge";
import { clearCrossSectionSpan } from "./crossSectionSelection";

export interface CrossSectionNavigationPluginOptions {
  onCursorExitRef: {
    readonly current: ((exit: SectionArrowExit) => void) | undefined;
  };
}

export function crossSectionNavigationPlugin({
  onCursorExitRef,
}: CrossSectionNavigationPluginOptions) {
  return $prose(() => new Plugin({
    props: {
      handleKeyDown(view, event) {
        const exitCb = onCursorExitRef.current;
        if (!exitCb) return false;

        const exit = sectionExitForArrow(view, event.key);
        if (!exit) {
          if (!event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            clearCrossSectionSpan();
          }
          return false;
        }
        if (event.shiftKey) {
          exitCb({ ...exit, extend: true });
          return true;
        }
        clearCrossSectionSpan();
        exitCb(exit);
        return true;
      },
    },
    view(editorView) {
      let dragging = false;
      let lastDestKey: string | null = null;
      const onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) return;
        dragging = true;
        lastDestKey = null;
        if (!event.shiftKey) clearCrossSectionSpan();
        try {
          editorView.dom.setPointerCapture(event.pointerId);
        } catch {
          // Capture is best-effort; window fallback below still runs.
        }
      };
      const endDrag = (event: PointerEvent): void => {
        if ((event.buttons & 1) !== 0) return;
        dragging = false;
        lastDestKey = null;
        try {
          if (editorView.dom.hasPointerCapture(event.pointerId)) {
            editorView.dom.releasePointerCapture(event.pointerId);
          }
        } catch {
          // View may already be destroyed.
        }
      };
      const emitPointerExtend = (event: PointerEvent): void => {
        if (!dragging || (event.buttons & 1) === 0) {
          if ((event.buttons & 1) === 0) dragging = false;
          return;
        }
        const exitCb = onCursorExitRef.current;
        if (!exitCb) return;
        const rect = editorView.dom.getBoundingClientRect();
        let toward: "up" | "down" | null = null;
        if (event.clientY < rect.top) toward = "up";
        else if (event.clientY > rect.bottom) toward = "down";
        if (!toward) return;
        const atEdge = toward === "up" ? editorView.endOfTextblock("up") : editorView.endOfTextblock("down");
        if (!atEdge) return;
        const dest = document.elementFromPoint(event.clientX, event.clientY);
        const destKey = dest instanceof Element
          ? dest.closest("[data-document-section][data-fragment-key]")?.getAttribute("data-fragment-key")
          : null;
        const selfKey = editorView.dom.closest("[data-document-section][data-fragment-key]")
          ?.getAttribute("data-fragment-key");
        if (!destKey || destKey === lastDestKey || destKey === selfKey) return;
        lastDestKey = destKey;
        exitCb({
          toward,
          column: event.clientX,
          extend: true,
          pointer: { x: event.clientX, y: event.clientY },
        });
      };
      editorView.dom.addEventListener("pointerdown", onPointerDown);
      editorView.dom.addEventListener("pointermove", emitPointerExtend);
      editorView.dom.addEventListener("pointerup", endDrag);
      editorView.dom.addEventListener("pointercancel", endDrag);
      window.addEventListener("pointermove", emitPointerExtend);
      window.addEventListener("pointerup", endDrag);
      return {
        destroy() {
          editorView.dom.removeEventListener("pointerdown", onPointerDown);
          editorView.dom.removeEventListener("pointermove", emitPointerExtend);
          editorView.dom.removeEventListener("pointerup", endDrag);
          editorView.dom.removeEventListener("pointercancel", endDrag);
          window.removeEventListener("pointermove", emitPointerExtend);
          window.removeEventListener("pointerup", endDrag);
        },
      };
    },
  }));
}
