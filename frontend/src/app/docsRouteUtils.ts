import { encodeDocPath } from "../utils/path-encoding";

export type DocsRouteMode = "view";

export interface ResolvedDocsRoute {
  mode: DocsRouteMode;
  docPath: string | null;
}

function normalizeSplatPath(routeSplat: string | undefined): string {
  if (!routeSplat) {
    return "";
  }
  // Decode, strip trailing slashes only, then ensure exactly one leading slash.
  const decoded = decodeURIComponent(routeSplat).replace(/\/+$/g, "");
  if (!decoded) return "";
  return decoded.startsWith("/") ? decoded : `/${decoded}`;
}

export function resolveDocsSubroute(routeSplat: string | undefined): ResolvedDocsRoute {
  const normalized = normalizeSplatPath(routeSplat);
  if (normalized.length === 0) {
    return { mode: "view", docPath: null };
  }
  return { mode: "view", docPath: normalized };
}

/**
 * Strip the leading slash from a canonical doc path for embedding in a
 * `/docs/...` browser route URL. The route prefix already provides the
 * leading segment, so the doc path portion must not start with `/`.
 *
 * This is ONLY for route URL construction — do not use it as a general
 * doc-path normalizer.
 */
export function stripLeadingSlashForRoute(docPath: string): string {
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

  return `/docs/${stripLeadingSlashForRoute(encodeDocPath(decodedPath))}${suffix}`;
}
