function FileCountIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
      <path
        d="M4.5 2.25h5.1L12.5 5.15V13.25a.75.75 0 0 1-.75.75h-7.25a.75.75 0 0 1-.75-.75V3a.75.75 0 0 1 .75-.75Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path d="M9.25 2.35V5.5H12.3" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}

function FolderCountIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
      <path
        d="M2.5 4.25A1.25 1.25 0 0 1 3.75 3h3.1l1.2 1.35h4.2A1.25 1.25 0 0 1 13.5 5.6v6.15A1.25 1.25 0 0 1 12.25 13H3.75A1.25 1.25 0 0 1 2.5 11.75V4.25Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface FolderCardProps {
  name: string;
  fileCount: number;
  folderCount: number;
  /** Direct child file display names for the subtitle line. */
  fileNames: string[];
  newCount?: number;
  accent?: "new" | "agent" | null;
  hasAgentMarker?: boolean;
  onClick: () => void;
}

export function FolderCard({
  name,
  fileCount,
  folderCount,
  fileNames,
  newCount,
  accent = null,
  hasAgentMarker = false,
  onClick,
}: FolderCardProps) {
  const accentClass =
    accent === "new" ? "bg-folder-new" : accent === "agent" ? "bg-agent" : null;
  const subtitle = fileNames.length > 0 ? fileNames.join(", ") : "empty";

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative inline-grid w-max max-w-full grid-cols-[minmax(0,max-content)] rounded-md border border-folder-card-border bg-folder-card-bg py-2.5 pr-3 pl-3 text-left transition-colors hover:border-folder-card-border-hover hover:bg-canvas-bg"
    >
      {accentClass ? (
        <span
          className={`absolute bottom-2 left-0 top-2 w-[3px] rounded-r-sm ${accentClass}`}
          aria-hidden="true"
        />
      ) : null}
      <span className="flex min-w-0 items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5">
          {hasAgentMarker ? (
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-agent" aria-hidden="true" />
          ) : null}
          <span className="truncate text-[14px] font-semibold text-folder-link group-hover:text-folder-link-hover group-hover:underline">
            {name}
          </span>
          {newCount != null && newCount > 0 ? (
            <span className="shrink-0 rounded px-1.5 py-px text-[10px] font-semibold leading-tight bg-folder-new-bg text-folder-new-text">
              {newCount} new
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 pt-0.5 text-[11px] text-text-faint">
          {fileCount > 0 ? (
            <span className="inline-flex items-center gap-0.5" title={`${fileCount} files`}>
              {fileCount}
              <FileCountIcon />
            </span>
          ) : null}
          {folderCount > 0 ? (
            <span className="inline-flex items-center gap-0.5" title={`${folderCount} folders`}>
              {folderCount}
              <FolderCountIcon />
            </span>
          ) : null}
          {fileCount === 0 && folderCount === 0 ? <span>empty</span> : null}
        </span>
      </span>
      <span
        className="mt-0.5 block w-0 min-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-text-faint"
        title={subtitle}
      >
        {subtitle}
      </span>
    </button>
  );
}
