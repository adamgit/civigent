import { useLayoutEffect, type RefObject } from "react";
import type { MilkdownEditorHandle } from "./MilkdownEditor";
import type { Placement } from "../status/live-document-session";
import { insertBodyBlockIfMissing, pmPosForPlacement } from "../pages/split-caret";

function applyPlacement(handle: MilkdownEditorHandle, placement: Placement): void {
  if ("coords" in placement) {
    handle.focusAtCoords(placement.coords.x, placement.coords.y);
    return;
  }
  if ("at" in placement) {
    handle.focus(placement.at, placement.column);
    return;
  }
  const view = handle.getView();
  if (!view) {
    requestAnimationFrame(() => applyPlacement(handle, placement));
    return;
  }
  insertBodyBlockIfMissing(view);
  handle.focusAtPos(pmPosForPlacement(view.state.doc, placement.retarget));
}

export function PlaceCaret({
  handleRef,
  placement,
  onPlaced,
}: {
  handleRef: RefObject<MilkdownEditorHandle | null>;
  placement: Placement;
  onPlaced: () => void;
}) {
  useLayoutEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    applyPlacement(handle, placement);
    onPlaced();
  }, [handleRef, placement, onPlaced]);
  return null;
}
