import { encodeDocPath } from "../utils/path-encoding";
import { DocPath } from "../types/shared";

export type DocsRouteMode = "view";

export interface ResolvedDocsRoute {
  mode: DocsRouteMode;
  docPath: DocPath | null;
  folderPath: string | null;
}

function decodeSlashStrippedRouteSegment(routeSplat: string | undefined): string {
  if (!routeSplat) {
    return "";
  }
  return decodeURIComponent(routeSplat).replace(/\/+$/g, "").replace(/^\/+/, "");
}

export function resolveDocsSubroute(routeSplat: string | undefined): ResolvedDocsRoute {
  const slashStrippedSegment = decodeSlashStrippedRouteSegment(routeSplat);
  if (slashStrippedSegment.length === 0) {
    return { mode: "view", docPath: null, folderPath: null };
  }
  if (DocPath.isSlashStrippedUrlSegmentOfDocPath(slashStrippedSegment)) {
    return {
      mode: "view",
      docPath: DocPath.fromSlashStrippedUrlSegment(slashStrippedSegment),
      folderPath: null,
    };
  }
  return { mode: "view", docPath: null, folderPath: `/${slashStrippedSegment}` };
}

export function stripLeadingSlashForRoute(docPath: DocPath): string {
  return docPath.replace(/^\/+/, "");
}

/**
 * Translate a markdown href that points at a root-absolute wiki doc path into
 * the app's `/docs/...` browser route. Non-doc hrefs are left alone by
 * returning null so callers can preserve normal link behavior.
 */
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
    // Preserve the original text if the href contains malformed escapes.
  }

  if (!/\.md$/i.test(decodedPath)) {
    return null;
  }

  return `/docs/${stripLeadingSlashForRoute(DocPath.parse(encodeDocPath(decodedPath)))}${suffix}`;
}
