import type { EditorView } from "@milkdown/prose/view";

export const EDITOR_FRAGMENT_KEY_ATTR = "data-editor-fragment-key";

export interface DragSessionEditor {
  readonly fragmentKey: string;
  readonly root: HTMLElement;
  readonly view: EditorView;
}

const editorsByRoot = new WeakMap<HTMLElement, DragSessionEditor>();

const EDITOR_ROOT_SELECTOR = `[${EDITOR_FRAGMENT_KEY_ATTR}]`;

/**
 * Marks a mounted editor's own root element with the live fragment key it edits and
 * records that root's current `EditorView` for the document drag session. Both halves
 * happen here so a marked root always resolves to a view: the mark is what tells a
 * pointer hit it landed inside a mounted editor rather than on a static row's markdown
 * (a section wrapper's `data-fragment-key` is on both), and the view is what the grip
 * and hover owner resolvers need for that fragment.
 */
export function registerDragSessionEditor(
  root: HTMLElement,
  fragmentKey: string,
  view: EditorView,
): void {
  root.setAttribute(EDITOR_FRAGMENT_KEY_ATTR, fragmentKey);
  editorsByRoot.set(root, { fragmentKey, root, view });
}

export function unregisterDragSessionEditor(root: HTMLElement): void {
  root.removeAttribute(EDITOR_FRAGMENT_KEY_ATTR);
  editorsByRoot.delete(root);
}

/**
 * Resolves a pointer hit (the grip handle itself, or any node inside a mounted editor)
 * to the registered editor that owns it. Returns null for a hit on a static row, on page
 * chrome, or inside an editor root whose view has already been unregistered.
 */
export function resolveDragSessionEditorAt(hit: Node): DragSessionEditor | null {
  const element = hit instanceof Element ? hit : hit.parentElement;
  const root = element?.closest(EDITOR_ROOT_SELECTOR);
  if (!(root instanceof HTMLElement)) return null;
  return editorsByRoot.get(root) ?? null;
}
