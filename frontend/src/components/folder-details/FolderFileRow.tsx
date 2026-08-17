import { Link } from "react-router-dom";
import { SectionHeadingBarcode } from "./SectionHeadingBarcode";

/**
 * Clickable file row. The outer element is a real <Link href>, not a
 * <button onClick={navigate}>. Fake click-handlers are not links: they break
 * open-in-new-tab, middle-click, copy-link, and every non-JS browser path.
 */

export type FolderFileStatusDot = "new" | "agent";

export interface FolderFileSectionHeading {
  name: string;
  level: number;
}

export interface FolderFileRowProps {
  name: string;
  meta?: string;
  /** Section / heading names shown on hover to the right of the filename. */
  sectionHeadings?: FolderFileSectionHeading[];
  statusDots?: FolderFileStatusDot[];
  /** Document route. This row is a real <Link>, never a click handler. */
  to: string;
}

const DOT_CLASS: Record<FolderFileStatusDot, string> = {
  new: "bg-folder-new",
  agent: "bg-agent",
};

function SectionPreview({ headings }: { headings: FolderFileSectionHeading[] }) {
  if (headings.length === 0) {
    return <span className="text-[12px] text-text-faint">No sections</span>;
  }

  return (
    <span
      className="block truncate text-[12px] text-text-secondary"
      title={headings.map((heading) => heading.name).join(" · ")}
    >
      {headings.map((heading, index) => (
        <span key={`${index}-${heading.name}`}>
          {index > 0 ? <span className="text-text-faint"> · </span> : null}
          <span className="font-mono text-[10px] font-semibold text-folder-link" aria-hidden="true">
            H{heading.level}{" "}
          </span>
          {heading.name}
        </span>
      ))}
    </span>
  );
}

export function FolderFileRow({
  name,
  meta,
  sectionHeadings,
  statusDots = [],
  to,
}: FolderFileRowProps) {
  return (
    <Link
      to={to}
      className="group flex w-full min-w-0 items-center gap-3 py-2.5 text-left no-underline transition-colors hover:bg-section-hover"
    >
      {statusDots.length > 0 ? (
        <span className="flex w-3.5 shrink-0 items-center justify-center gap-0.5" aria-hidden="true">
          {statusDots.map((dot, index) => (
            <span
              key={`${dot}-${index}`}
              className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_CLASS[dot]}`}
            />
          ))}
        </span>
      ) : null}
      <span className="max-w-full min-w-0 shrink-0 truncate text-[15px] font-medium text-folder-link group-hover:text-folder-link-hover group-hover:underline md:max-w-[50%]">
        {name}
      </span>
      <span className="ml-auto min-w-0 flex-1 overflow-hidden text-right max-md:hidden">
        {sectionHeadings !== undefined ? (
          <>
            <span className="hidden group-hover:block">
              <SectionPreview headings={sectionHeadings} />
            </span>
            <span className="flex min-w-0 items-center justify-end gap-2 group-hover:hidden">
              {meta ? <span className="truncate text-[11px] text-text-faint">{meta}</span> : null}
              <SectionHeadingBarcode levels={sectionHeadings.map((heading) => heading.level)} />
            </span>
          </>
        ) : meta ? (
          <span className="block truncate text-[11px] text-text-faint">{meta}</span>
        ) : null}
      </span>
    </Link>
  );
}
