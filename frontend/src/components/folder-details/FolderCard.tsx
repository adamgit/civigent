/** Bytes per approximate "page" for cheap mass signals. Not a real page measure. */
export const APPROX_BYTES_PER_PAGE = 2000;

/** Muted leather-bound spine colours — stable pick via path hash. */
const SPINE_COLORS = [
  "#6b3a3a", // burgundy
  "#4a5d4a", // forest
  "#3d4a5c", // navy
  "#6b5344", // brown
  "#5c5a3a", // olive
  "#5a4050", // plum
  "#8a5a45", // rust
  "#3d5a58", // teal
  "#4a5058", // slate
  "#7a6a48", // tan
  "#5a3d3d", // deep maroon
  "#455545", // moss
] as const;

const SHELF_HEIGHT_PX = 14;
const SPINE_MIN_HEIGHT_RATIO = 0.4;
/** Visible spines before the overflow mark; the rest stay in the tooltip. */
const MAX_VISIBLE_SPINES = 5;

export interface FolderBookSpine {
  /** Stable identity (doc path) for colour hashing and keys. */
  path: string;
  /** Approximate on-disk content size in bytes. */
  sizeBytes: number;
  /** Display name for tooltip. */
  name: string;
}

export interface FolderCardAccess {
  read: string;
  write: string;
}

export interface FolderCardProps {
  name: string;
  fileCount: number;
  folderCount: number;
  /** Direct child file display names for the subtitle line. */
  fileNames: string[];
  /** Direct child files with sizes — drives the micro bookshelf. */
  books?: FolderBookSpine[];
  access?: FolderCardAccess | null;
  newCount?: number;
  accent?: "new" | "agent" | null;
  hasAgentMarker?: boolean;
  onClick: () => void;
}

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

function PrivateFolderIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
      <rect x="3.25" y="7" width="9.5" height="6.25" rx="1.25" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PublicFolderIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
      <rect x="3.25" y="7" width="9.5" height="6.25" rx="1.25" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M5.25 7V5.25a2.75 2.75 0 0 1 5.35-.95"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FolderAccessMarker({ access }: { access: FolderCardAccess }) {
  const isPublicAccess = access.read === "public" || access.write === "public";
  const label = isPublicAccess
    ? `Public folder — read: ${access.read} · write: ${access.write}`
    : `Private folder — read: ${access.read} · write: ${access.write}`;
  return (
    <span
      className={`inline-flex shrink-0 items-center ${
        isPublicAccess ? "text-status-red" : "text-folder-private"
      }`}
      title={label}
      aria-label={label}
    >
      {isPublicAccess ? <PublicFolderIcon /> : <PrivateFolderIcon />}
    </span>
  );
}

function hashPath(path: string): number {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function spineColorForPath(path: string): string {
  return SPINE_COLORS[hashPath(path) % SPINE_COLORS.length]!;
}

export function approxPagesFromBytes(sizeBytes: number): number {
  if (sizeBytes <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(sizeBytes / APPROX_BYTES_PER_PAGE));
}

function MicroBookshelf({ books }: { books: FolderBookSpine[] }) {
  const maxBytes = books.reduce((max, book) => Math.max(max, book.sizeBytes), 0);
  const visible = books.slice(0, MAX_VISIBLE_SPINES);
  const hiddenCount = books.length - visible.length;
  const hiddenNames = hiddenCount > 0 ? books.slice(MAX_VISIBLE_SPINES).map((book) => book.name) : [];

  return (
    <span
      className="flex max-w-[50%] items-end gap-px"
      style={{ height: `${SHELF_HEIGHT_PX}px` }}
      aria-hidden="true"
    >
      <span className="flex min-w-0 items-end gap-px overflow-hidden">
        {visible.map((book) => {
          // Unknown/zero sizes: uniform mid height so the shelf still reads as books.
          const ratio = maxBytes > 0 ? book.sizeBytes / maxBytes : 0.65;
          const heightPx = Math.round(
            SHELF_HEIGHT_PX * (SPINE_MIN_HEIGHT_RATIO + (1 - SPINE_MIN_HEIGHT_RATIO) * ratio),
          );
          const pages = approxPagesFromBytes(book.sizeBytes);
          return (
            <span
              key={book.path}
              title={`${book.name} · ~${pages} page${pages === 1 ? "" : "s"}`}
              className="w-[3px] shrink-0 rounded-[1px]"
              style={{
                height: `${heightPx}px`,
                backgroundColor: spineColorForPath(book.path),
                opacity: 0.88,
              }}
            />
          );
        })}
      </span>
      {hiddenCount > 0 ? (
        <span
          className="ml-0.5 shrink-0 self-end text-[10px] leading-none text-text-faint"
          title={`${hiddenCount} more: ${hiddenNames.join(", ")}`}
        >
          …
        </span>
      ) : null}
    </span>
  );
}

export function FolderCard({
  name,
  fileCount,
  folderCount,
  fileNames,
  books = [],
  access = null,
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
      className="group relative grid w-full min-w-0 max-w-full rounded-md border border-folder-card-border bg-folder-card-bg py-2.5 pr-3 pl-3 text-left transition-colors hover:border-folder-card-border-hover hover:bg-canvas-bg"
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
          {access ? <FolderAccessMarker access={access} /> : null}
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
      <span className="mt-0.5 flex w-0 min-w-full items-end gap-2.5">
        {books.length > 0 ? <MicroBookshelf books={books} /> : null}
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-text-faint"
          title={subtitle}
        >
          {subtitle}
        </span>
      </span>
    </button>
  );
}
