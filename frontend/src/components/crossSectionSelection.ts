import { useSyncExternalStore } from "react";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/prose/view";
import { $prose } from "@milkdown/utils";
import { selectionAtSectionEdge, selectionOnSectionLine, type SectionArrowExit } from "./sectionEdge";

export const crossSectionHighlightKey = new PluginKey("crossSectionHighlight");

export interface CrossSectionSpan {
  keys: string[];
  startPos: number;
  endPos: number;
  anchorKey: string;
  anchorPos: number;
  headKey: string;
  headPos: number;
}

let activeSpan: CrossSectionSpan | null = null;
const spanListeners = new Set<() => void>();
const registeredViews = new Set<EditorView>();

function notifySpan(): void {
  for (const listener of spanListeners) listener();
}

export function getActiveCrossSectionSpan(): CrossSectionSpan | null {
  return activeSpan;
}

export function subscribeCrossSectionSpan(onStoreChange: () => void): () => void {
  spanListeners.add(onStoreChange);
  return () => {
    spanListeners.delete(onStoreChange);
  };
}

function spanKeysSnapshot(): string {
  return activeSpan?.keys.join("\0") ?? "";
}

const EMPTY_KEYS: readonly string[] = [];

export function useCrossSectionSpanKeys(): readonly string[] {
  const snapshot = useSyncExternalStore(subscribeCrossSectionSpan, spanKeysSnapshot, spanKeysSnapshot);
  return snapshot === "" ? EMPTY_KEYS : snapshot.split("\0");
}

function highlightSet(view: EditorView, from: number, to: number): DecorationSet {
  const doc = view.state.doc;
  const a = Math.max(0, Math.min(from, to, doc.content.size));
  const b = Math.max(0, Math.min(Math.max(from, to), doc.content.size));
  const decos: Decoration[] = [];
  if (a === b) {
    try {
      const $pos = doc.resolve(a);
      if ($pos.depth > 0 && $pos.parent.isTextblock && $pos.parent.content.size === 0) {
        decos.push(Decoration.node($pos.before(), $pos.after(), { class: "cross-section-selection-block" }));
      }
    } catch {
      return DecorationSet.empty;
    }
  } else if (a === 0 && b === doc.content.size) {
    doc.forEach((node, pos) => {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "cross-section-selection-block" }));
    });
  } else {
    decos.push(Decoration.inline(a, b, { class: "cross-section-selection" }));
  }
  return DecorationSet.create(doc, decos);
}

export function setCrossSectionHighlight(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setMeta(crossSectionHighlightKey, highlightSet(view, from, to)));
}

export function clearCrossSectionHighlight(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(crossSectionHighlightKey, "clear"));
}

export function clearCrossSectionSpan(): void {
  const hadSpan = activeSpan !== null;
  activeSpan = null;
  for (const view of registeredViews) {
    try {
      clearCrossSectionHighlight(view);
    } catch {
      // View may already be destroyed.
    }
  }
  if (hadSpan) notifySpan();
}

export function crossSectionHighlightPlugin() {
  return $prose(() => new Plugin({
    key: crossSectionHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(crossSectionHighlightKey);
        if (meta === "clear") return DecorationSet.empty;
        if (meta instanceof DecorationSet) return meta;
        return set.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return crossSectionHighlightKey.getState(state);
      },
    },
    view(editorView) {
      registeredViews.add(editorView);
      const onMouseDown = (event: MouseEvent): void => {
        if (event.shiftKey) return;
        clearCrossSectionSpan();
      };
      editorView.dom.addEventListener("mousedown", onMouseDown);
      return {
        destroy() {
          registeredViews.delete(editorView);
          editorView.dom.removeEventListener("mousedown", onMouseDown);
        },
      };
    },
  }));
}

function selectBlockAt(view: EditorView, pos: number): { from: number; to: number } | null {
  try {
    const $pos = view.state.doc.resolve(pos);
    if ($pos.depth < 1) return null;
    const sel = NodeSelection.create(view.state.doc, $pos.before($pos.depth));
    view.dispatch(view.state.tr.setSelection(sel));
    return { from: sel.from, to: sel.to };
  } catch {
    return null;
  }
}

export function extendSourceSelectionToEdge(
  view: EditorView,
  toward: "up" | "down",
): { from: number; to: number } {
  const edge = toward === "up" ? "start" : "end";
  const edgeHead = selectionAtSectionEdge(view.state.doc, edge).head;
  const anchor = view.state.selection.anchor;
  if (anchor === edgeHead) {
    const block = selectBlockAt(view, edgeHead);
    if (block) return block;
  }
  const sel = TextSelection.create(view.state.doc, anchor, edgeHead);
  view.dispatch(view.state.tr.setSelection(sel));
  return { from: Math.min(sel.anchor, sel.head), to: Math.max(sel.anchor, sel.head) };
}

export function selectDestFromEdge(
  view: EditorView,
  toward: "up" | "down",
  column: number | null,
): { from: number; to: number } {
  const edge = toward === "up" ? "end" : "start";
  const edgeHead = selectionAtSectionEdge(view.state.doc, edge).head;
  const landed = column == null
    ? selectionAtSectionEdge(view.state.doc, edge)
    : selectionOnSectionLine(view, edge, column);
  if (edgeHead === landed.head) {
    const block = selectBlockAt(view, edgeHead);
    if (block) {
      view.focus();
      return block;
    }
  }
  const sel = TextSelection.create(view.state.doc, edgeHead, landed.head);
  view.dispatch(view.state.tr.setSelection(sel));
  view.focus();
  return { from: Math.min(sel.anchor, sel.head), to: Math.max(sel.anchor, sel.head) };
}

export function selectDestAtCoords(
  view: EditorView,
  toward: "up" | "down",
  x: number,
  y: number,
): { from: number; to: number } {
  const edge = toward === "up" ? "end" : "start";
  const edgeHead = selectionAtSectionEdge(view.state.doc, edge).head;
  const hit = view.posAtCoords({ left: x, top: y });
  const destPos = hit ? Math.max(0, Math.min(hit.pos, view.state.doc.content.size)) : edgeHead;
  if (edgeHead === destPos) {
    const block = selectBlockAt(view, edgeHead);
    if (block) {
      view.focus();
      return block;
    }
  }
  const sel = TextSelection.create(view.state.doc, edgeHead, destPos);
  view.dispatch(view.state.tr.setSelection(sel));
  view.focus();
  return { from: Math.min(sel.anchor, sel.head), to: Math.max(sel.anchor, sel.head) };
}

function keysBetween(orderedKeys: readonly string[], a: string, b: string): string[] | null {
  const i = orderedKeys.indexOf(a);
  const j = orderedKeys.indexOf(b);
  if (i < 0 || j < 0) return null;
  return i <= j ? orderedKeys.slice(i, j + 1) : orderedKeys.slice(j, i + 1);
}

export function resolveExitDestination(
  sourceFk: string,
  toward: "up" | "down",
  orderedKeys: readonly string[],
  pointer?: { x: number; y: number },
): string | null {
  if (pointer) {
    const el = document.elementFromPoint(pointer.x, pointer.y);
    const key = el instanceof Element
      ? el.closest("[data-document-section][data-fragment-key]")?.getAttribute("data-fragment-key")
      : null;
    if (key && key !== sourceFk && orderedKeys.includes(key)) return key;
  }
  const pos = orderedKeys.indexOf(sourceFk);
  if (pos < 0) return null;
  const dest = orderedKeys[toward === "up" ? pos - 1 : pos + 1];
  return dest ?? null;
}

function paintSpanHighlights(args: {
  keys: readonly string[];
  anchorKey: string;
  anchorPos: number;
  headKey: string;
  getView: (fragmentKey: string) => EditorView | null;
  forward: boolean;
}): void {
  for (const key of args.keys) {
    const view = args.getView(key);
    if (!view) continue;
    if (key === args.headKey) {
      clearCrossSectionHighlight(view);
      continue;
    }
    if (key === args.anchorKey) {
      if (args.forward) setCrossSectionHighlight(view, args.anchorPos, view.state.doc.content.size);
      else setCrossSectionHighlight(view, 0, args.anchorPos);
      continue;
    }
    setCrossSectionHighlight(view, 0, view.state.doc.content.size);
  }
}

function tryNativeSpanSelection(span: CrossSectionSpan, getView: (fragmentKey: string) => EditorView | null): void {
  try {
    const startView = getView(span.keys[0]);
    const endView = getView(span.keys[span.keys.length - 1]);
    if (!startView || !endView) return;
    const start = startView.domAtPos(span.startPos);
    const end = endView.domAtPos(span.endPos);
    window.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  } catch {
    // Native spanning selection is best-effort; decorations + span still stand.
  }
}

export function runExtendedCursorExit(args: {
  sourceFk: string;
  exit: SectionArrowExit;
  orderedKeys: readonly string[];
  canFocusKey: (fragmentKey: string) => boolean;
  getView: (fragmentKey: string) => EditorView | null;
  focusDest: (destFk: string) => void;
}): boolean {
  const destFk = resolveExitDestination(args.sourceFk, args.exit.toward, args.orderedKeys, args.exit.pointer);
  if (!destFk || destFk === args.sourceFk || !args.canFocusKey(destFk)) return false;
  const existing = activeSpan;
  const keepAnchor = existing !== null && existing.keys.includes(args.sourceFk);
  const sourceView = args.getView(args.sourceFk);
  let capturedAnchorPos = 0;
  if (keepAnchor) {
    capturedAnchorPos = existing.anchorPos;
    if (sourceView) extendSourceSelectionToEdge(sourceView, args.exit.toward);
  } else if (sourceView) {
    const range = extendSourceSelectionToEdge(sourceView, args.exit.toward);
    capturedAnchorPos = args.exit.toward === "down" ? range.from : range.to;
  }
  args.focusDest(destFk);
  let attempts = 0;
  const tryApply = (): void => {
    if (args.getView(destFk) == null && attempts < 10) {
      attempts += 1;
      requestAnimationFrame(tryApply);
      return;
    }
    applyCrossSectionExtend({
      sourceFk: args.sourceFk,
      destFk,
      toward: args.exit.toward,
      column: args.exit.column,
      pointer: args.exit.pointer,
      orderedKeys: args.orderedKeys,
      getView: args.getView,
      capturedAnchorKey: keepAnchor ? existing.anchorKey : args.sourceFk,
      capturedAnchorPos,
    });
  };
  requestAnimationFrame(() => requestAnimationFrame(tryApply));
  return true;
}

export function applyCrossSectionExtend(args: {
  sourceFk: string;
  destFk: string;
  toward: "up" | "down";
  column: number | null;
  pointer?: { x: number; y: number };
  orderedKeys: readonly string[];
  getView: (fragmentKey: string) => EditorView | null;
  capturedAnchorKey?: string;
  capturedAnchorPos?: number;
}): boolean {
  const destView = args.getView(args.destFk);
  if (!destView) return false;

  const destRange = args.pointer
    ? selectDestAtCoords(destView, args.toward, args.pointer.x, args.pointer.y)
    : selectDestFromEdge(destView, args.toward, args.column);

  const existing = activeSpan;
  const keepAnchor = existing !== null && existing.keys.includes(args.sourceFk);
  const anchorKey = args.capturedAnchorKey
    ?? (keepAnchor ? existing.anchorKey : args.sourceFk);
  const sourceView = args.getView(args.sourceFk);
  const sourceSel = sourceView?.state.selection;
  const fallbackAnchorPos = sourceSel
    ? (args.toward === "down"
      ? Math.min(sourceSel.anchor, sourceSel.head, sourceSel.from)
      : Math.max(sourceSel.anchor, sourceSel.head, sourceSel.to))
    : 0;
  const anchorPos = args.capturedAnchorPos
    ?? (keepAnchor ? existing.anchorPos : fallbackAnchorPos);
  const headKey = args.destFk;
  const headPos = args.toward === "down" ? destRange.to : destRange.from;

  if (headKey === anchorKey) {
    clearCrossSectionSpan();
    return true;
  }

  const keys = keysBetween(args.orderedKeys, anchorKey, headKey);
  if (!keys || keys.length === 0) return false;

  const forward = args.orderedKeys.indexOf(anchorKey) <= args.orderedKeys.indexOf(headKey);
  activeSpan = {
    keys,
    startPos: forward ? anchorPos : headPos,
    endPos: forward ? headPos : anchorPos,
    anchorKey,
    anchorPos,
    headKey,
    headPos,
  };
  notifySpan();

  paintSpanHighlights({
    keys,
    anchorKey,
    anchorPos,
    headKey,
    getView: args.getView,
    forward,
  });
  tryNativeSpanSelection(activeSpan, args.getView);
  return true;
}
