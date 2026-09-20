import { Link } from "react-router-dom";
import { SectionHeadingBarcode } from "./SectionHeadingBarcode";
import { compactAge, compactAgeTint } from "../../utils/prettyAge";
import type { FolderFilesSort, FolderFilesSortKey } from "./folder-files-sort";

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
  secondsAgo?: number | null;
  /** Document route. This row is a real <Link>, never a click handler. */
  to: string;
}

const DOT_CLASS: Record<FolderFileStatusDot, string> = {
  new: "bg-folder-new",
  agent: "bg-agent",
};

const FILE_LIST_COLUMNS = {
  row: "flex w-full min-w-0 items-center gap-3",
  recent: "w-16 shrink-0",
  name: "min-w-0 flex-1 truncate md:max-w-[50%]",
  sections: "ml-auto min-w-0 flex-1 overflow-hidden text-right",
} as const;

const SORT_HEADINGS: Array<{
  key: FolderFilesSortKey;
  label: string;
  column: "recent" | "name" | "sections";
}> = [
  { key: "recent", label: "Recent", column: "recent" },
  { key: "name", label: "File name", column: "name" },
  { key: "sections", label: "Sections", column: "sections" },
];

export function FolderFileListHeadings({
  sort,
  onSort,
}: {
  sort: FolderFilesSort;
  onSort: (key: FolderFilesSortKey) => void;
}) {
  return (
    <div
      className={`${FILE_LIST_COLUMNS.row} border-b border-folder-divider pb-1.5`}
      role="group"
      aria-label="Sort files"
    >
      {SORT_HEADINGS.map((heading) => {
        const active = sort.key === heading.key;
        return (
          <button
            key={heading.key}
            type="button"
            className={`${FILE_LIST_COLUMNS[heading.column]} cursor-pointer whitespace-nowrap border-none bg-transparent p-0 font-ui text-[10px] font-semibold uppercase tracking-[0.14em] hover:text-text-secondary ${
              heading.column === "sections" ? "" : "text-left"
            } ${active ? "text-text-secondary" : "text-text-faint"}`}
            role="columnheader"
            aria-sort={
              active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
            }
            onClick={() => onSort(heading.key)}
          >
            {heading.label}
            {active ? (
              <span className="ml-0.5" aria-hidden="true">
                {sort.direction === "asc" ? "↑" : "↓"}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

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
  secondsAgo,
  to,
}: FolderFileRowProps) {
  return (
    <Link
      to={to}
      className={`group ${FILE_LIST_COLUMNS.row} py-2.5 text-left no-underline transition-colors hover:bg-section-hover`}
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
      <span
        className={`${FILE_LIST_COLUMNS.recent} tabular-nums text-[11px] font-medium`}
        style={typeof secondsAgo === "number" ? { color: compactAgeTint(secondsAgo) } : undefined}
      >
        {typeof secondsAgo === "number" ? compactAge(secondsAgo) : null}
      </span>
      <span className={`${FILE_LIST_COLUMNS.name} text-[15px] font-medium text-folder-link group-hover:text-folder-link-hover group-hover:underline`}>
        {name}
      </span>
      <span className={FILE_LIST_COLUMNS.sections}>
        {sectionHeadings !== undefined ? (
          <>
            <span className="hidden group-hover:block">
              <SectionPreview headings={sectionHeadings} />
            </span>
            <span className="flex min-w-0 max-w-full items-center justify-end gap-2 overflow-hidden group-hover:hidden">
              {meta ? <span className="min-w-0 truncate text-[11px] text-text-faint">{meta}</span> : null}
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
