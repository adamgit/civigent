import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import { docPaperSectionScrollOffsetPx } from "./DocumentPaperStickyHeader";
import { sharedDraftBarScrollClearancePx } from "./SharedDraftBanner";

const PROSEMIRROR_DEFAULT_SCROLL_MARGIN_PX = 5;

export function caretScrollClearancePlugin() {
  return $prose(() => new Plugin({
    props: {
      scrollThreshold: {
        get top() {
          return docPaperSectionScrollOffsetPx();
        },
        get bottom() {
          return sharedDraftBarScrollClearancePx();
        },
        left: 0,
        right: 0,
      },
      scrollMargin: {
        get top() {
          return docPaperSectionScrollOffsetPx() + PROSEMIRROR_DEFAULT_SCROLL_MARGIN_PX;
        },
        get bottom() {
          return sharedDraftBarScrollClearancePx() + PROSEMIRROR_DEFAULT_SCROLL_MARGIN_PX;
        },
        left: PROSEMIRROR_DEFAULT_SCROLL_MARGIN_PX,
        right: PROSEMIRROR_DEFAULT_SCROLL_MARGIN_PX,
      },
    },
  }));
}
