import { $prose } from "@milkdown/utils";
import { Plugin } from "@milkdown/prose/state";

export interface DocumentBoundaryPluginOptions {
  onDocumentBoundaryRef: {
    readonly current: ((boundary: "start" | "end") => void) | undefined;
  };
}

export function documentBoundaryPlugin({
  onDocumentBoundaryRef,
}: DocumentBoundaryPluginOptions) {
  return $prose(() => new Plugin({
    props: {
      handleKeyDown(_view, event) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        if (event.shiftKey || event.altKey) return false;
        if (event.key !== "Home" && event.key !== "End") return false;

        const onDocumentBoundary = onDocumentBoundaryRef.current;
        if (!onDocumentBoundary) return false;
        onDocumentBoundary(event.key === "Home" ? "start" : "end");
        return true;
      },
    },
  }));
}
