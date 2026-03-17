import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sectionHeadingKey } from "../types/shared.js";
import type { DocStructureNode } from "../types/shared.js";
import { flattenStructureTree, estimateDocSize } from "../pages/document-page-utils";

interface DocumentLoadingSkeletonProps {
  structureTree: DocStructureNode[] | null;
}

export function DocumentLoadingSkeleton({ structureTree }: DocumentLoadingSkeletonProps) {
  if (!structureTree) {
    return <p className="text-sm text-text-muted">Loading document...</p>;
  }

  const flatSkeleton = flattenStructureTree(structureTree);
  const sectionCount = flatSkeleton.length;

  return (
    <>
      {/* Metadata summary banner */}
      <div className="text-xs text-text-muted font-[family-name:var(--font-mono)] mb-4 p-2 bg-slate-50 rounded border border-slate-200">
        <span>Loading {sectionCount.toLocaleString()} sections ({estimateDocSize(sectionCount)})...</span>
        {sectionCount > 500 ? (
          <span className="ml-2 text-amber-600">
            Large document — consider splitting for better performance.
          </span>
        ) : null}
      </div>

      {/* Skeleton outline: heading tree with placeholder content bars */}
      {flatSkeleton.map((entry) => {
        const key = sectionHeadingKey(entry.headingPath);
        const heading = entry.headingPath[entry.headingPath.length - 1] ?? "";
        const depth = Math.max(1, entry.headingPath.length);
        return (
          <div
            key={key}
            className="relative m-[-16px] p-[4px_16px] rounded-md border-l-[2.5px] border-l-slate-200"
          >
            {heading ? (
              <div className="doc-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {`${"#".repeat(depth)} ${heading}`}
                </ReactMarkdown>
              </div>
            ) : null}
            <div className="space-y-1.5 mt-1 mb-2">
              <div className="h-3 w-3/4 bg-slate-100 rounded animate-pulse" />
              <div className="h-3 w-1/2 bg-slate-100 rounded animate-pulse" />
            </div>
          </div>
        );
      })}
    </>
  );
}
