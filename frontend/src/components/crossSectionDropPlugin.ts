import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { proseMirrorNodeToMarkdown } from "@ks/milkdown-serializer";
import { pmPosToMarkdownOffset } from "../services/drop-position";
import {
  applyDragOverVerdict,
  type SectionTransfer,
  type DropVerdict,
} from "../services/section-transfer";

export interface DragSourceInfo {
  fragmentKey: string;
  from: number;
  to: number;
  view: EditorView;
}

export let dragSourceInfo: DragSourceInfo | null = null;

export function setDragSourceInfo(info: DragSourceInfo | null): void {
  dragSourceInfo = info;
}

export interface CrossSectionDropPluginOptions {
  fragmentKey: string;
  canDropRef: { readonly current: (() => DropVerdict) | undefined };
  onCrossSectionDropRef: {
    readonly current: ((transfer: SectionTransfer) => void) | undefined;
  };
}

export function crossSectionDropPlugin({
  fragmentKey,
  canDropRef,
  onCrossSectionDropRef,
}: CrossSectionDropPluginOptions) {
  return $prose(() => new Plugin({
    props: {
      handleDOMEvents: {
        dragstart(view) {
          const { from, to } = view.state.selection;
          dragSourceInfo = { fragmentKey, from, to, view };
          return false;
        },
        dragend() {
          dragSourceInfo = null;
          return false;
        },
        dragover(_view, event) {
          if (!dragSourceInfo || dragSourceInfo.fragmentKey === fragmentKey) return false;

          const canDropFn = canDropRef.current;
          if (!canDropFn) return false;

          const verdict = canDropFn();
          const allowed = applyDragOverVerdict(event, verdict, true);
          return !allowed;
        },
      },
      handleDrop(view, event) {
        const dropCb = onCrossSectionDropRef.current;
        if (!dropCb || !event) return false;

        const source = dragSourceInfo;
        if (!source || source.fragmentKey === fragmentKey) return false;

        event.preventDefault();

        const dt = event.dataTransfer;
        const plainText = dt?.getData("text/plain") ?? "";

        const sourceView = source.view;
        const sourceFrom = source.from;
        const sourceTo = source.to;
        const slice = sourceView.state.doc.slice(sourceFrom, sourceTo);
        const docNode = sourceView.state.doc.type.create(null, slice.content);
        const md = proseMirrorNodeToMarkdown(docNode);

        const deleteSourceCallback = () => {
          const tr = sourceView.state.tr.delete(sourceFrom, sourceTo);
          sourceView.dispatch(tr);
        };

        let insertionOffset: number | undefined;
        const posResult = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (posResult) {
          const targetMarkdown = proseMirrorNodeToMarkdown(view.state.doc);
          insertionOffset = pmPosToMarkdownOffset(view, posResult.pos, targetMarkdown);
        }

        const transfer: SectionTransfer = {
          sourceFragmentKey: source.fragmentKey,
          sourceHeadingPath: [],
          targetFragmentKey: fragmentKey,
          targetHeadingPath: [],
          content: { markdown: md, plainText },
          sourceSliceRange: { from: sourceFrom, to: sourceTo },
          deleteFromSource: true,
          insertionOffset,
          deleteSourceCallback,
        };

        dropCb(transfer);
        dragSourceInfo = null;
        return true;
      },
    },
  }));
}
