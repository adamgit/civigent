import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";
import { sectionExitForArrow, type SectionArrowExit } from "./sectionEdge";

export interface CrossSectionNavigationPluginOptions {
  onCursorExitRef: {
    readonly current: ((exit: SectionArrowExit) => void) | undefined;
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

        const exit = sectionExitForArrow(view, event.key);
        if (!exit) return false;
        exitCb(exit);
        return true;
      },
    },
  }));
}
