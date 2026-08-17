import type { DocumentTreeEntry } from "../../types/shared.js";
import { FolderTreeRadialDots } from "./FolderTreeRadialDots";

/**
 * Experimental page-scale reuse of the folder's parent-card icon.
 * Remove this component's single call site to remove the experiment.
 */
export function FolderTreePageWatermark({ entry }: { entry: DocumentTreeEntry }) {
  return (
    <div
      className="pointer-events-none sticky top-0 z-0 h-0 w-full max-w-5xl overflow-visible opacity-[0.036]"
      aria-hidden="true"
    >
      <span className="absolute left-[55%] top-[50dvh] block aspect-square w-[132%] -translate-x-1/2 -translate-y-1/2">
        <FolderTreeRadialDots entry={entry} className="h-full w-full text-folder-link" />
      </span>
    </div>
  );
}
