import type { DocumentTreeEntry } from "../../types/shared.js";
import { FolderTreeRadialDots } from "./FolderTreeRadialDots";

export function FolderTreePageWatermark({ entry }: { entry: DocumentTreeEntry }) {
  return (
    <div
      className="folder-tree-page-watermark pointer-events-none absolute top-0 left-0 z-0 w-full h-dvh overflow-clip"
      aria-hidden="true"
    >
      <div className="relative h-full w-full px-8 max-md:px-4">
        <div className="relative h-full w-full max-w-5xl">
          <span className="absolute left-[55%] top-1/2 block aspect-square w-[132%] -translate-x-1/2 -translate-y-1/2">
            <FolderTreeRadialDots entry={entry} className="h-full w-full text-folder-link" />
          </span>
        </div>
      </div>
    </div>
  );
}
