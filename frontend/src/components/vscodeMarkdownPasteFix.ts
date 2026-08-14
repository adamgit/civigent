import type { Ctx } from "@milkdown/ctx";
import { editorViewOptionsCtx, parserCtx, schemaCtx } from "@milkdown/core";
import { isTextOnlySlice } from "@milkdown/prose";
import { DOMParser, DOMSerializer, type Slice } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";

function handleVscodeMarkdownPaste(ctx: Ctx, view: EditorView, event: ClipboardEvent): boolean {
  if (!view.editable) return false;
  const currentNode = view.state.selection.$from.node();
  if (currentNode.type.spec.code) return false;
  const { clipboardData } = event;
  if (!clipboardData) return false;
  const vscodeData = clipboardData.getData("vscode-editor-data");
  const text = clipboardData.getData("text/plain");
  if (vscodeData.length === 0 || text.length === 0) return false;

  const schema = ctx.get(schemaCtx);
  const parser = ctx.get(parserCtx);
  const parsed = parser(text);
  if (!parsed || typeof parsed === "string") return false;
  const dom = DOMSerializer.fromSchema(schema).serializeFragment(parsed.content);
  const slice = DOMParser.fromSchema(schema).parseSlice(dom);
  const node = isTextOnlySlice(slice);
  if (node) {
    view.dispatch(view.state.tr.replaceSelectionWith(node, true));
    return true;
  }
  try {
    view.dispatch(view.state.tr.replaceSelection(slice));
    return true;
  } catch {
    return false;
  }
}

export function vscodeMarkdownPasteFix(ctx: Ctx): void {
  ctx.update(editorViewOptionsCtx, (prev) => {
    const prevHandlePaste = prev.handlePaste;
    return {
      ...prev,
      handlePaste: (view: EditorView, event: ClipboardEvent, slice: Slice) => {
        if (handleVscodeMarkdownPaste(ctx, view, event)) return true;
        return prevHandlePaste
          ? (prevHandlePaste.call(view.props, view, event, slice) ?? false)
          : false;
      },
    };
  });
}
