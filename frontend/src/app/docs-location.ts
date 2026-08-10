import { DocPath, FolderPath } from "../types/shared";
import { encodeDocPath, encodeFolderPath } from "../utils/path-encoding";

export type DocsLocation =
  | { kind: "index" }
  | { kind: "doc"; docPath: DocPath }
  | { kind: "folder"; folderPath: FolderPath }
  | { kind: "invalid"; raw: string; reason: string };

function lawViolationReason(prefixed: string): string {
  const fileLikeSegment = prefixed
    .split("/")
    .filter((segment) => segment.length > 0)
    .find((segment) => segment.endsWith(".md") || segment.endsWith(".sections"));
  if (fileLikeSegment) {
    return `segment ${JSON.stringify(fileLikeSegment)} looks like a file name — folder names may never end in ".md" or ".sections", so this is an illegal folder path`;
  }
  return `Invalid folder path: ${JSON.stringify(prefixed)}`;
}

export const DocsLocation = {
  fromPathname(pathname: string): DocsLocation | null {
    if (pathname !== "/docs" && !pathname.startsWith("/docs/")) {
      return null;
    }
    const remainder = pathname.slice("/docs".length).replace(/^\/+/, "").replace(/\/+$/, "");
    if (remainder.length === 0) {
      return { kind: "index" };
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(remainder);
    } catch {
      return { kind: "invalid", raw: remainder, reason: "the URL contains a malformed percent-escape" };
    }
    const prefixed = `/${decoded}`;
    const docPath = DocPath.tryParse(prefixed);
    if (docPath) {
      return { kind: "doc", docPath };
    }
    const folderPath = FolderPath.tryParse(prefixed);
    if (folderPath) {
      return { kind: "folder", folderPath };
    }
    return { kind: "invalid", raw: prefixed, reason: lawViolationReason(prefixed) };
  },
};

export function docHref(docPath: DocPath): string {
  return `/docs/${encodeDocPath(docPath)}`;
}

export function folderHref(folderPath: FolderPath): string {
  return folderPath === FolderPath.root ? "/docs" : `/docs/${encodeFolderPath(folderPath)}`;
}

export function docsRouteForStoredPath(rawPath: string | undefined | null): string | null {
  if (rawPath == null || rawPath.length === 0) return null;
  const docPath = DocPath.coerce(rawPath);
  if (!docPath) return null;
  return docHref(docPath);
}

export function rewriteMarkdownDocHref(href: string): string | null {
  if (!href.startsWith("/")) {
    return null;
  }

  const suffixStart = href.search(/[?#]/);
  const rawPath = suffixStart >= 0 ? href.slice(0, suffixStart) : href;
  const suffix = suffixStart >= 0 ? href.slice(suffixStart) : "";

  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }

  if (!/\.md$/i.test(decodedPath)) {
    return null;
  }

  const route = docsRouteForStoredPath(decodedPath);
  return route ? `${route}${suffix}` : null;
}
