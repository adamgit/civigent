export const FOLDER_FILES_SORT_STORAGE_KEY = "ks_folder_files_sort";

export const FOLDER_FILES_SORT_KEYS = ["recent", "name", "sections"] as const;
export type FolderFilesSortKey = (typeof FOLDER_FILES_SORT_KEYS)[number];

export const FOLDER_FILES_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type FolderFilesSortDirection = (typeof FOLDER_FILES_SORT_DIRECTIONS)[number];

export interface FolderFilesSort {
  key: FolderFilesSortKey;
  direction: FolderFilesSortDirection;
}

export const FOLDER_FILES_SORT_DEFAULT_DIRECTION: Record<
  FolderFilesSortKey,
  FolderFilesSortDirection
> = {
  recent: "desc",
  name: "asc",
  sections: "asc",
};

export const DEFAULT_FOLDER_FILES_SORT: FolderFilesSort = {
  key: "recent",
  direction: FOLDER_FILES_SORT_DEFAULT_DIRECTION.recent,
};

export interface FolderFilesSortSectionHeading {
  name: string;
}

export interface FolderFilesSortContext {
  ages: Record<string, number | null> | null;
  sectionHeadings: Record<string, FolderFilesSortSectionHeading[]>;
}

function isFolderFilesSortKey(value: string): value is FolderFilesSortKey {
  return (FOLDER_FILES_SORT_KEYS as readonly string[]).includes(value);
}

function isFolderFilesSortDirection(value: string): value is FolderFilesSortDirection {
  return (FOLDER_FILES_SORT_DIRECTIONS as readonly string[]).includes(value);
}

export function parseFolderFilesSort(value: string | null | undefined): FolderFilesSort | null {
  if (value == null || value.length === 0) {
    return null;
  }
  const separator = value.indexOf(":");
  const key = separator === -1 ? value : value.slice(0, separator);
  const direction = separator === -1 ? "" : value.slice(separator + 1);
  if (!isFolderFilesSortKey(key)) {
    return null;
  }
  if (direction.length === 0) {
    return { key, direction: FOLDER_FILES_SORT_DEFAULT_DIRECTION[key] };
  }
  if (!isFolderFilesSortDirection(direction)) {
    return null;
  }
  return { key, direction };
}

export function serializeFolderFilesSort(sort: FolderFilesSort): string {
  return `${sort.key}:${sort.direction}`;
}

export function readFolderFilesSort(): FolderFilesSort {
  try {
    return parseFolderFilesSort(localStorage.getItem(FOLDER_FILES_SORT_STORAGE_KEY))
      ?? DEFAULT_FOLDER_FILES_SORT;
  } catch {
    return DEFAULT_FOLDER_FILES_SORT;
  }
}

export function writeFolderFilesSort(sort: FolderFilesSort): void {
  try {
    localStorage.setItem(FOLDER_FILES_SORT_STORAGE_KEY, serializeFolderFilesSort(sort));
  } catch {
    /* Ignore localStorage failures in constrained environments. */
  }
}

export function nextFolderFilesSort(
  current: FolderFilesSort,
  clicked: FolderFilesSortKey,
): FolderFilesSort {
  if (current.key === clicked) {
    return {
      key: clicked,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }
  return {
    key: clicked,
    direction: FOLDER_FILES_SORT_DEFAULT_DIRECTION[clicked],
  };
}

function fileDisplayName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function compareByFileName(a: string, b: string): number {
  return fileDisplayName(a).localeCompare(fileDisplayName(b), undefined, { sensitivity: "base" });
}

function sectionSortText(headings: FolderFilesSortSectionHeading[] | undefined): string {
  if (headings === undefined || headings.length === 0) {
    return "";
  }
  return headings.map((heading) => heading.name).join("\n");
}

function compareRecent(
  a: string,
  b: string,
  ages: Record<string, number | null> | null,
  direction: FolderFilesSortDirection,
): number {
  const ageA = ages?.[a];
  const ageB = ages?.[b];
  const hasA = typeof ageA === "number";
  const hasB = typeof ageB === "number";
  if (!hasA && !hasB) {
    return compareByFileName(a, b);
  }
  if (!hasA) {
    return 1;
  }
  if (!hasB) {
    return -1;
  }
  const delta = ageA - ageB;
  return direction === "desc" ? delta : -delta;
}

function compareSections(
  a: string,
  b: string,
  sectionHeadings: Record<string, FolderFilesSortSectionHeading[]>,
  direction: FolderFilesSortDirection,
): number {
  const textA = sectionSortText(sectionHeadings[a]);
  const textB = sectionSortText(sectionHeadings[b]);
  const emptyA = textA.length === 0;
  const emptyB = textB.length === 0;
  if (emptyA && emptyB) {
    return compareByFileName(a, b);
  }
  if (emptyA) {
    return 1;
  }
  if (emptyB) {
    return -1;
  }
  const delta = textA.localeCompare(textB, undefined, { sensitivity: "base" });
  return (direction === "asc" ? delta : -delta) || compareByFileName(a, b);
}

export function compareFolderFiles(
  a: string,
  b: string,
  sort: FolderFilesSort,
  context: FolderFilesSortContext,
): number {
  if (sort.key === "recent") {
    return compareRecent(a, b, context.ages, sort.direction);
  }
  if (sort.key === "sections") {
    return compareSections(a, b, context.sectionHeadings, sort.direction);
  }
  const delta = compareByFileName(a, b);
  return sort.direction === "desc" ? -delta : delta;
}
