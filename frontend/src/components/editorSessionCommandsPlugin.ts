import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import type { EditorSessionCommands } from "../contexts/EditorSessionCommandsContext";

export interface EditorSessionCommandsPluginOptions {
  commandsRef: { readonly current: EditorSessionCommands };
}

function selectionInsideTable(view: EditorView): boolean {
  const { $head } = view.state.selection;
  for (let depth = $head.depth; depth > 0; depth--) {
    if ($head.node(depth).type.name === "table") return true;
  }
  return false;
}

export function editorSessionCommandsPlugin({
  commandsRef,
}: EditorSessionCommandsPluginOptions) {
  return $prose(() => new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        if (event.shiftKey || event.altKey) return false;
        if (event.key !== "Enter") return false;

        if (selectionInsideTable(view)) return false;

        const forcePublish = commandsRef.current.forcePublish;
        if (typeof forcePublish === "function") {
          forcePublish();
          return true;
        }
        return false;
      },
    },
  }));
}
