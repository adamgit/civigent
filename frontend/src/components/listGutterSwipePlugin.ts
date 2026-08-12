import { Plugin } from "@milkdown/prose/state";
import { liftListItem, sinkListItem } from "@milkdown/prose/schema-list";
import { $prose } from "@milkdown/utils";
import type { EditorView } from "@milkdown/prose/view";

const GUTTER_START_OFFSET_PX = 28;
const GUTTER_END_OFFSET_PX = 6;
const SWIPE_THRESHOLD_PX = 36;

interface ListGutterSwipe {
  pointerId: number;
  listItemPos: number;
  startX: number;
  startY: number;
  direction: "indent" | "outdent" | null;
}

function listItemPosAtSelection(view: EditorView): number | null {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "list_item") {
      return $from.before(depth);
    }
  }
  return null;
}

function listItemAtTarget(view: EditorView, target: EventTarget | null): HTMLLIElement | null {
  if (!(target instanceof Element)) return null;
  const item = target.closest("li");
  if (!(item instanceof HTMLLIElement) || !view.dom.contains(item)) return null;
  return item;
}

function listItemPosAtDom(view: EditorView, item: HTMLLIElement): number | null {
  const pos = view.posAtDOM(item, 0);
  const $pos = view.state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === "list_item") {
      return $pos.before(depth);
    }
  }
  return null;
}

function startsInListMarkerGutter(item: HTMLLIElement, clientX: number): boolean {
  const { left } = item.getBoundingClientRect();
  return clientX >= left - GUTTER_START_OFFSET_PX && clientX <= left + GUTTER_END_OFFSET_PX;
}

function applyListIndent(view: EditorView, direction: "indent" | "outdent"): boolean {
  const listItemType = view.state.schema.nodes.list_item;
  if (!listItemType) return false;

  const command = direction === "indent" ? sinkListItem(listItemType) : liftListItem(listItemType);
  return command(view.state, view.dispatch, view);
}

/**
 * Touch-only list nesting for the item whose caret is already active:
 * swipe its marker gutter right to indent, or left to outdent.
 *
 * The plugin dispatches a normal ProseMirror transaction, preserving Milkdown's
 * undo, markdown conversion, and y-prosemirror binding. It deliberately has no
 * visual controls or React state.
 */
export function listGutterSwipePlugin() {
  return $prose(() => {
    let swipe: ListGutterSwipe | null = null;

    const clearSwipe = (view: EditorView, pointerId?: number) => {
      if (swipe && (pointerId === undefined || swipe.pointerId === pointerId)) {
        if (view.dom.hasPointerCapture(swipe.pointerId)) {
          view.dom.releasePointerCapture(swipe.pointerId);
        }
        swipe = null;
      }
    };

    return new Plugin({
      props: {
        handleDOMEvents: {
          pointerdown(view, event) {
            if (!view.editable || event.pointerType !== "touch" || !view.hasFocus()) return false;

            const item = listItemAtTarget(view, event.target);
            if (!item || !startsInListMarkerGutter(item, event.clientX)) return false;

            const selectedListItemPos = listItemPosAtSelection(view);
            const touchedListItemPos = listItemPosAtDom(view, item);
            if (selectedListItemPos === null || selectedListItemPos !== touchedListItemPos) return false;

            swipe = {
              pointerId: event.pointerId,
              listItemPos: touchedListItemPos,
              startX: event.clientX,
              startY: event.clientY,
              direction: null,
            };
            view.dom.setPointerCapture(event.pointerId);
            return false;
          },

          pointermove(view, event) {
            if (!swipe || event.pointerId !== swipe.pointerId) return false;

            const dx = event.clientX - swipe.startX;
            const dy = event.clientY - swipe.startY;
            if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) >= SWIPE_THRESHOLD_PX) {
              clearSwipe(view, event.pointerId);
              return false;
            }
            if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return false;

            swipe.direction = dx > 0 ? "indent" : "outdent";
            // `handleDOMEvents` requires the plugin to prevent the browser
            // default itself when it handles an event.
            event.preventDefault();
            return true;
          },

          pointerup(view, event) {
            if (!swipe || event.pointerId !== swipe.pointerId) return false;

            const completedSwipe = swipe;
            clearSwipe(view, event.pointerId);
            if (!completedSwipe.direction) return false;

            // The caret must still be inside the original list item. A remote
            // change or a native selection move during the gesture cancels it.
            if (listItemPosAtSelection(view) !== completedSwipe.listItemPos) return false;

            event.preventDefault();
            applyListIndent(view, completedSwipe.direction);
            return true;
          },

          pointercancel(view, event) {
            clearSwipe(view, event.pointerId);
            return false;
          },
        },
      },
    });
  });
}
