/**
 * WS-6: caret capture-and-recover for cross-section moves.
 *
 * A cross-section move is backend-owned: the DocSession actor reorders the
 * proposal skeleton and RE-SEEDS the live Y.Doc fragments from the new layout
 * inside one `Y.transact` (MW-10). Re-seeding re-mints the moved fragment's
 * Y.XmlFragment structs, so a `Y.RelativePosition` (which anchors to struct ids)
 * cannot survive — but the fragment KEY is stable (the reorder preserves the
 * section-file id), so we recover the caret by CONTENT OFFSET: capture the
 * selection's absolute offsets in the source editor before the move, then
 * restore them (clamped to the re-seeded doc) in the same fragment's editor once
 * the server update has propagated.
 *
 * This is the spec's "capture-and-recover" for the one explicit cursor concern
 * (`architecture.md` §Cross-Section Cursor Movement). It is best-effort: the move
 * itself is 100% data-correct regardless; this only restores the caret.
 */

import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";

/**
 * The ProseMirror editor view surface caret recovery needs. We alias the real
 * `EditorView` so a `MilkdownEditorHandle.getView()` result is assignable without
 * structural-variance friction; tests pass a minimal cast mock.
 */
export type CaretEditorView = EditorView;

export interface CaretOffsets {
  anchor: number;
  head: number;
}

/**
 * Capture the current selection offsets from `view`, but only when it actually
 * holds focus (an unfocused editor has no meaningful caret to recover). Returns
 * null otherwise.
 */
export function captureCaretOffsets(view: CaretEditorView | null | undefined): CaretOffsets | null {
  if (!view || !view.hasFocus()) return null;
  const sel = view.state.selection;
  return { anchor: sel.anchor, head: sel.head };
}

/** Clamp captured offsets into the bounds of a (possibly resized) document. */
export function clampCaretOffsets(offsets: CaretOffsets, docContentSize: number): CaretOffsets {
  const clamp = (n: number): number => Math.max(0, Math.min(n, docContentSize));
  return { anchor: clamp(offsets.anchor), head: clamp(offsets.head) };
}

/**
 * Restore captured offsets into `view` (clamped to its current doc), focusing it.
 * No-op when `view` or `offsets` is null.
 */
export function restoreCaretOffsets(
  view: CaretEditorView | null | undefined,
  offsets: CaretOffsets | null,
): void {
  if (!view || !offsets) return;
  const { anchor, head } = clampCaretOffsets(offsets, view.state.doc.content.size);
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head));
  view.dispatch(tr);
  view.focus();
}
