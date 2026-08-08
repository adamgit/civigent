import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";

export interface CrossSectionNavigationPluginOptions {
  onCursorExitRef: {
    readonly current: ((direction: "up" | "down") => void) | undefined;
  };
}

export function crossSectionNavigationPlugin({
  onCursorExitRef,
}: CrossSectionNavigationPluginOptions) {
  return $prose(() => new Plugin({
    props: {
      handleKeyDown(view, event) {
        const exitCb = onCursorExitRef.current;
        if (!exitCb) return false;

        if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          const { $head } = view.state.selection;
          if ($head.pos <= 1) {
            exitCb("up");
            return true;
          }
        }
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          const { $head } = view.state.selection;
          if ($head.pos >= view.state.doc.content.size - 1) {
            exitCb("down");
            return true;
          }
        }
        return false;
      },
    },
  }));
}
