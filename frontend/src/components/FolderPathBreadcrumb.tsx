import { Link } from "react-router-dom";
import { folderHref } from "../app/docs-location";
import { FolderPath } from "../types/shared";

export function FolderGlyphIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.25A1.25 1.25 0 0 1 3.75 3h3.1l1.2 1.35h4.2A1.25 1.25 0 0 1 13.5 5.6v6.15A1.25 1.25 0 0 1 12.25 13H3.75A1.25 1.25 0 0 1 2.5 11.75V4.25Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ParentPathIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 13H8V4"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.25 6.5L8 3.5L10.75 6.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Containing folder of a document path; root-level docs resolve to `FolderPath.root`. */
export function folderPathOfDoc(docPath: string): FolderPath {
  const lastSlash = docPath.lastIndexOf("/");
  if (lastSlash <= 0) return FolderPath.root;
  return FolderPath.tryParse(docPath.slice(0, lastSlash)) ?? FolderPath.root;
}

export type FolderPathBreadcrumbSize = "title" | "subtitle";

/**
 * Clickable folder trail: `/ docs / a / b /`.
 *
 * `title` is the folder-details heading — large type, leaf is the current
 * folder (not a link). `subtitle` is the document-header trail — small type,
 * every segment including the leaf is a link into that folder.
 */
export function FolderPathBreadcrumb({
  folderPath,
  size = "title",
}: {
  folderPath: FolderPath;
  size?: FolderPathBreadcrumbSize;
}) {
  const parts = folderPath.split("/").filter(Boolean);
  const isTitle = size === "title";
  const segmentClass = isTitle
    ? "font-inherit text-inherit no-underline hover:text-text-secondary hover:underline"
    : "font-inherit text-inherit no-underline hover:text-text-secondary hover:underline px-0.5 py-0.5";
  const slashClass = "mx-1 shrink-0 text-folder-new";
  const sizeClass = isTitle
    ? "font-ui text-[22px] leading-[28px] tracking-tight"
    : "font-ui text-xs leading-4 tracking-tight";

  return (
    <span
      className={`folder-path-breadcrumb inline-flex w-max items-center whitespace-nowrap ${sizeClass} ${
        isTitle && parts.length === 0 ? "max-md:hidden" : ""
      }`}
    >
      {isTitle ? (
        <span
          className="mr-1.5 hidden shrink-0 text-text-muted max-md:inline-flex"
          title="Parent folder path"
        >
          <ParentPathIcon />
        </span>
      ) : null}
      <span
        className={`mr-1.5 inline-flex shrink-0 text-folder-new ${isTitle ? "max-md:hidden" : ""}`}
      >
        <FolderGlyphIcon size={isTitle ? 18 : 12} />
      </span>
      <span className={slashClass} aria-hidden="true">
        /
      </span>
      <Link
        to={folderHref(FolderPath.root)}
        className={`shrink-0 text-text-faint ${segmentClass}`}
        aria-label="Open documents root"
      >
        docs
      </Link>
      <span className={slashClass} aria-hidden="true">
        /
      </span>
      {parts.map((part, index) => {
        const segmentPath = `/${parts.slice(0, index + 1).join("/")}`;
        const isLast = index === parts.length - 1;
        const leafIsCurrent = isTitle && isLast;
        return (
          <span
            key={segmentPath}
            className={`inline-flex shrink-0 items-center ${leafIsCurrent ? "max-md:hidden" : ""}`}
          >
            {leafIsCurrent ? (
              <span className="font-semibold text-text-primary">{part}</span>
            ) : (
              <Link
                to={folderHref(FolderPath.parse(segmentPath))}
                className={`text-text-faint ${segmentClass}`}
                aria-label={`Open folder ${segmentPath}`}
              >
                {part}
              </Link>
            )}
            <span className={slashClass} aria-hidden="true">
              /
            </span>
          </span>
        );
      })}
    </span>
  );
}
