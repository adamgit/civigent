import type { Node } from "@milkdown/prose/model";
import { Selection, TextSelection, type EditorState } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

/**
 * A section edge is the first or last place a caret can sit, which is inside
 * a text block. A list, quote, or table ends before the document's last
 * position, so a raw offset of 0 or content.size - 1 is not that caret.
 *
 * A vertical arrow keeps the caret's horizontal position, the same way
 * ProseMirror moves between a heading and the body. A horizontal arrow lands
 * on the first or last caret.
 */

export interface SectionArrowExit {
  toward: "up" | "down";
  column: number | null;
  /** Shift-arrow / mouse-drag extend, not a collapsed caret handoff. */
  extend?: boolean;
  pointer?: { x: number; y: number };
}

export function selectionAtSectionEdge(doc: Node, edge: "start" | "end"): Selection {
  return edge === "start" ? Selection.atStart(doc) : Selection.atEnd(doc);
}

export function selectionOnSectionLine(
  view: EditorView,
  edge: "start" | "end",
  column: number,
): Selection {
  const edgeSelection = selectionAtSectionEdge(view.state.doc, edge);
  if (!edgeSelection.$head.parent.isTextblock) return edgeSelection;
  let box: { top: number; bottom: number };
  try {
    box = view.coordsAtPos(edgeSelection.head);
  } catch {
    return edgeSelection;
  }
  if (box.bottom <= box.top) return edgeSelection;
  const hit = view.posAtCoords({ left: column, top: (box.top + box.bottom) / 2 });
  if (!hit) return edgeSelection;
  const bias = edge === "end" ? -1 : 1;
  const landed = TextSelection.near(view.state.doc.resolve(hit.pos), bias);
  if (!landed.$head.parent.isTextblock) return edgeSelection;
  if (landed.$head.start() !== edgeSelection.$head.start()) return edgeSelection;
  return landed;
}

function textblockBeyond(state: EditorState, dir: -1 | 1): boolean {
  const $head = state.selection.$head;
  if ($head.depth === 0) return Selection.findFrom($head, dir, true) != null;
  const boundary = dir < 0 ? $head.before() : $head.after();
  return Selection.findFrom(state.doc.resolve(boundary), dir, true) != null;
}

function caretColumn(view: EditorView): number | null {
  try {
    return view.coordsAtPos(view.state.selection.head).left;
  } catch {
    return null;
  }
}

/**
 * Up and left leave toward the previous section. Down and right leave toward
 * the next one. The arrow leaves only when it cannot reach another text block
 * in this section. The search starts at the current text block's boundary, so
 * the rest of the heading is not treated as somewhere further to go.
 * Vertical arrows carry the caret's viewport x. Horizontal arrows do not.
 */
export function sectionExitForArrow(view: EditorView, key: string): SectionArrowExit | null {
  if (key === "ArrowUp" || key === "ArrowLeft") {
    const vertical = key === "ArrowUp";
    const atEdge = vertical ? view.endOfTextblock("up") : view.endOfTextblock("backward");
    if (!atEdge || textblockBeyond(view.state, -1)) return null;
    return { toward: "up", column: vertical ? caretColumn(view) : null };
  }
  if (key === "ArrowDown" || key === "ArrowRight") {
    const vertical = key === "ArrowDown";
    const atEdge = vertical ? view.endOfTextblock("down") : view.endOfTextblock("forward");
    if (!atEdge || textblockBeyond(view.state, 1)) return null;
    return { toward: "down", column: vertical ? caretColumn(view) : null };
  }
  return null;
}
