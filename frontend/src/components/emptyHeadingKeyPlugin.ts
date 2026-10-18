import { $prose } from "@milkdown/utils";
import { NodeSelection, Plugin, TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { Node } from "@milkdown/prose/model";

function headingTextIsEmpty(text: string): boolean {
  return text.replace(/[\s\u200B\u200C\u200D\uFEFF]/g, "") === "";
}

function emptyHeadingRange(view: EditorView): { from: number; to: number } | null {
  const { selection, doc } = view.state;
  if (selection instanceof NodeSelection) {
    const node = selection.node;
    if (node.type.name !== "heading" || !headingTextIsEmpty(node.textContent)) return null;
    return { from: selection.from, to: selection.to };
  }
  if (!selection.empty || selection.$from.depth < 1) return null;
  const node: Node = selection.$from.parent;
  if (node.type.name !== "heading" || !headingTextIsEmpty(node.textContent)) return null;
  const from = selection.$from.before(selection.$from.depth);
  const to = selection.$from.after(selection.$from.depth);
  if (from < 0 || to > doc.content.size) return null;
  return { from, to };
}

/**
 * Empty heading + Backspace/Delete must drop the heading node, not demote
 * H3→H2→H1. Changing the node's type in place (Milkdown's H1 setBlockType)
 * is a no-op on a y-prosemirror binding; inserting a paragraph then deleting
 * the heading is a Yjs-safe insert+delete.
 */
function deleteEmptyHeading(view: EditorView): boolean {
  const heading = emptyHeadingRange(view);
  if (!heading) return false;

  const paragraph = view.state.schema.nodes.paragraph;
  if (!paragraph) return false;

  const { from, to } = heading;
  let tr = view.state.tr.insert(to, paragraph.create());
  tr = tr.delete(from, to);
  if (tr.doc.childCount === 0) {
    tr = tr.insert(0, paragraph.create());
  }
  if (!tr.docChanged) return false;
  const pos = Math.min(from, tr.doc.content.size);
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function emptyHeadingKeyPlugin() {
  return $prose(() => new Plugin({
    view(editorView) {
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Backspace" && event.key !== "Delete") return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (!deleteEmptyHeading(editorView)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      editorView.dom.addEventListener("keydown", onKeyDown, true);
      return {
        destroy() {
          editorView.dom.removeEventListener("keydown", onKeyDown, true);
        },
      };
    },
  }));
}
